import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applySchema, openDb, type Db } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";
import { loadReferenceData, type ReferenceData } from "../src/db/queries.ts";
import { createApp } from "../src/web/app.ts";
import { processEmail } from "../src/workflow/processEmail.ts";
import { email25, FakeLlm } from "./fixtures.ts";

// The real app on a random free port (listen(0)), an in-memory database, a fake LLM.
let db: Db;
let ref: ReferenceData;
let server: Server;
let base: string;
let clean: number; // email 25, pending approval
let review: number; // needs review, with an unverified cost centre
let hostile: number; // a subject containing HTML

beforeAll(async () => {
  db = openDb(":memory:");
  applySchema(db);
  seedMasterData(db, parseMasterData(JSON.parse(readFileSync("data/master_data.json", "utf8"))));
  ref = loadReferenceData(db);

  const raw25 = readFileSync("data/emails/email_25.eml");
  clean = await processEmail(db, raw25, "email_25.eml", new FakeLlm(JSON.stringify(email25())), ref);
  const x = email25();
  x.cost_center_code = { value: "CC-9100", evidence: "Kostenstelle CC-9100" };
  review = await processEmail(db, raw25, null, new FakeLlm(JSON.stringify(x)), ref);
  const evil = Buffer.from("From: a@customer.com\r\nSubject: <script>alert(1)</script>\r\n\r\nBitte bestellen.");
  hostile = await processEmail(db, evil, null, new FakeLlm("x", "y"), ref);

  server = createApp({ db, ref, llm: new FakeLlm() }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const get = async (path: string, cookie?: string) => {
  const res = await fetch(base + path, { headers: cookie ? { cookie } : {} });
  return { status: res.status, html: await res.text() };
};

describe("inbox", () => {
  it("lists every requisition with its state, amount and next approver", async () => {
    const { status, html } = await get("/");
    expect(status).toBe(200);
    expect(html).toContain("3 requisitions");
    expect(html).toContain("pending approval");
    expect(html).toContain("needs review");
    expect(html).toContain("3,024.00"); // CHF amount of email 25
    expect(html).toContain("Daniel Kunz (EMP-103)"); // waiting for
  });

  it("filters by state", async () => {
    const { html } = await get("/?state=needs_review");
    expect(html).toContain("2 requisitions");
    expect(html).not.toContain("Daniel Kunz (EMP-103)");
  });

  it("shows an approver only what is waiting for them", async () => {
    expect((await get("/?mine=1", "actAs=EMP-103")).html).toContain("1 requisition");
    expect((await get("/?mine=1", "actAs=EMP-501")).html).toContain("0 requisitions"); // Andrea is step 2: not yet
  });
});

describe("detail page", () => {
  it("shows established values next to the model's claim and its evidence", async () => {
    const { html } = await get(`/requisitions/${clean}`);
    expect(html).toContain("SUP-011 TechnoPlast Kunststoffe GmbH");
    expect(html).toContain("UID: DE667788990"); // evidence quote
    expect(html).toContain("DELIVERY_DATE_MISSING");
    expect(html).toContain("waiting (current)");
    expect(html).toContain("extracted → pending_approval");
  });

  it("marks an unverified value and doesn't present it as established", async () => {
    const { html } = await get(`/requisitions/${review}`);
    const row = html.slice(html.indexOf("<td>Cost centre</td>"), html.indexOf("<td>Currency</td>"));
    expect(row).toContain("<strong>—</strong>"); // nothing established
    expect(row).toContain("unverified");
    expect(row).toContain("CC-9100"); // the claim is shown, clearly as a claim
  });

  it("returns 404 for an unknown requisition", async () => {
    expect((await get("/requisitions/9999")).status).toBe(404);
  });
});

describe("safety", () => {
  it("escapes email content: a hostile subject is shown as text, never run", async () => {
    for (const path of ["/", `/requisitions/${hostile}`]) {
      const { html } = await get(path);
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    }
  });

  it("ignores an act-as cookie for someone who doesn't exist", async () => {
    const { html } = await get("/", "actAs=EMP-999");
    expect(html).toContain('<option value="clerk" selected>');
  });

  it("only redirects back within the app after switching user", async () => {
    const res = await fetch(base + "/act-as", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", referer: "https://evil.example/phish" },
      body: "actor=EMP-103",
      redirect: "manual",
    });
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("actAs=EMP-103");
  });
});
