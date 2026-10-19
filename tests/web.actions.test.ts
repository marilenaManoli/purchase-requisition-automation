import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema, openDb, type Db } from "../src/db/db.ts";
import { parseMasterData, seedMasterData } from "../src/db/masterData.ts";
import { loadReferenceData, type ReferenceData } from "../src/db/queries.ts";
import { createApp } from "../src/web/app.ts";
import { parseAssignments, parseEditForm } from "../src/web/forms.ts";
import { processEmail } from "../src/workflow/processEmail.ts";
import { getState } from "../src/workflow/transitions.ts";
import { email23, email25, FakeErp, FakeLlm } from "./fixtures.ts";

describe("form parsing", () => {
  it("keeps only filled fields and turns line numbers into numbers", () => {
    expect(parseEditForm({
      supplierId: "SUP-011", costCenterCode: "", currency: " ",
      "line.0.unitPrice": "1'600.00", "line.0.quantity": "", "line.2.description": "Freight", "line.2.quantity": "abc",
      "line.0.evil": "x", other: "y",
    })).toEqual({
      supplierId: "SUP-011",
      lines: { "0": { unitPrice: 1600 }, "2": { description: "Freight", quantity: "abc" } }, // "abc" is left for zod to reject
    });
    expect(parseEditForm({})).toEqual({});
  });

  it("reads approver assignments", () => {
    expect(parseAssignments({ "assign.1": "EMP-701", "assign.2": "", note: "x" })).toEqual({ 1: "EMP-701" });
  });
});

// The real app over HTTP, against an in-memory database.
let db: Db;
let ref: ReferenceData;
let server: Server;
let base: string;
let app: ReturnType<typeof createApp>;

async function start(llm = new FakeLlm()) {
  db = openDb(":memory:");
  applySchema(db);
  seedMasterData(db, parseMasterData(JSON.parse(readFileSync("data/master_data.json", "utf8"))));
  ref = loadReferenceData(db);
  app = createApp({ db, ref, llm, erp: new FakeErp() });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
beforeEach(() => start());
afterEach(() => server.close());

/** Posts a form as `actor`; returns where it redirected to and the page shown there. */
async function post(path: string, actor: string, form: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `actAs=${actor}` },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });
  const location = res.headers.get("location") ?? "";
  const page = location ? await (await fetch(base + location, { headers: { cookie: `actAs=${actor}` } })).text() : await res.text();
  return { status: res.status, location, page };
}

const raw25 = readFileSync("data/emails/email_25.eml");
const raw23 = readFileSync("data/emails/email_23.eml");

describe("upload", () => {
  it("stores the email at once and finishes extraction in the background", async () => {
    server.close();
    await start(new FakeLlm(JSON.stringify(email25())));
    const res = await fetch(base + "/upload", {
      method: "POST",
      headers: { "content-type": "message/rfc822", "x-filename": "email_25.eml", cookie: "actAs=clerk" },
      body: raw25,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const id = Number(res.headers.get("location")?.split("/").pop());

    // Wait for the background extraction (the fake LLM answers immediately).
    for (let i = 0; i < 50 && app.extractionsRunning.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(getState(db, id)).toBe("pending_approval");
  });

  it("is a clerk action only", async () => {
    const res = await fetch(base + "/upload", {
      method: "POST", headers: { "content-type": "message/rfc822", cookie: "actAs=EMP-103" }, body: raw25, redirect: "manual",
    });
    expect(res.status).toBe(403);
  });
});

describe("approving through the UI", () => {
  let id: number;
  beforeEach(async () => {
    id = await processEmail(db, raw25, null, new FakeLlm(JSON.stringify(email25())), ref);
  });

  it("shows the decision form only to the current approver, and walks the chain", async () => {
    const forAndrea = await (await fetch(`${base}/requisitions/${id}`, { headers: { cookie: "actAs=EMP-501" } })).text();
    expect(forAndrea).not.toContain(`action="/requisitions/${id}/approve"`);

    const notYet = await post(`/requisitions/${id}/approve`, "EMP-501"); // a crafted post, not via the button
    expect(new URL(notYet.location, base).searchParams.get("error")).toContain("waiting for EMP-103");
    expect(getState(db, id)).toBe("pending_approval");

    await post(`/requisitions/${id}/approve`, "EMP-103", { comment: "ok" });
    const done = await post(`/requisitions/${id}/approve`, "EMP-501");
    expect(done.page).toContain("Approved.");
    expect(getState(db, id)).toBe("approved");
  });

  it("requires a reason to reject", async () => {
    const res = await post(`/requisitions/${id}/reject`, "EMP-103", { reason: "" });
    expect(res.page).toContain("A rejection needs a reason.");
    expect(getState(db, id)).toBe("pending_approval");
  });

  it("does not let an approver use clerk actions", async () => {
    expect((await post(`/requisitions/${id}/pull-back`, "EMP-103", { reason: "x" })).status).toBe(403);
  });
});

describe("clerk review through the UI", () => {
  it("edits a missing price, then sends for approval (free-of-charge style)", async () => {
    const x = email25();
    x.line_items[0]!.unit_price = null;
    const id = await processEmail(db, raw25, null, new FakeLlm(JSON.stringify(x)), ref);

    const edited = await post(`/requisitions/${id}/edit`, "clerk", { "line.0.unitPrice": "21" });
    expect(edited.page).toContain("Saved; all checks were run again.");
    expect(edited.page).toContain("Clerk set line 1 unitPrice");

    await post(`/requisitions/${id}/submit`, "clerk");
    expect(getState(db, id)).toBe("pending_approval");
  });

  it("shows a validation error from the edit instead of failing", async () => {
    const id = await processEmail(db, raw25, null, new FakeLlm("bad", "bad"), ref);
    const res = await post(`/requisitions/${id}/edit`, "clerk", { "line.0.description": "Clips" });
    expect(res.page).toContain("needs a description, quantity, unit and unit price");
  });

  it("assigns an approver where nobody is left (email 23) and resolves issues with a note", async () => {
    const id = await processEmail(db, raw23, null, new FakeLlm(JSON.stringify(email23())), ref);
    const page = await (await fetch(`${base}/requisitions/${id}`, { headers: { cookie: "actAs=clerk" } })).text();
    expect(page).toContain('name="assign.1"');

    const refused = await post(`/requisitions/${id}/submit`, "clerk", { "assign.1": "EMP-501" });
    expect(refused.page).toContain("The requester cannot be assigned");

    await post(`/requisitions/${id}/submit`, "clerk", { "assign.1": "EMP-701" });
    expect(getState(db, id)).toBe("pending_approval");
  });

  it("won't resolve an issue through another requisition's URL", async () => {
    const a = await processEmail(db, raw25, null, new FakeLlm("bad", "bad"), ref);
    const b = await processEmail(db, raw23, null, new FakeLlm("bad", "bad"), ref);
    const issueOfA = (db.prepare(`SELECT id FROM issues WHERE requisition_id = ?`).get(a) as { id: number }).id;
    const res = await post(`/requisitions/${b}/issues/${issueOfA}/resolve`, "clerk", { note: "x" });
    expect(res.page).toContain("belong to this requisition"); // the apostrophe is HTML-escaped on the page
  });
});

describe("ordering through the UI", () => {
  it("sets the delivery date after approval, then books the order and shows the PO number", async () => {
    const id = await processEmail(db, raw25, null, new FakeLlm(JSON.stringify(email25())), ref);
    await post(`/requisitions/${id}/approve`, "EMP-103");
    await post(`/requisitions/${id}/approve`, "EMP-501");

    const noDate = await post(`/requisitions/${id}/order`, "clerk");
    expect(noDate.page).toContain("needs a requested delivery date");

    await post(`/requisitions/${id}/delivery-date`, "clerk", { date: "2026-05-29" });
    const booked = await post(`/requisitions/${id}/order`, "clerk");
    expect(booked.page).toContain("Booked in the ERP.");
    expect(booked.page).toContain("PO-TEST-1");
    expect(getState(db, id)).toBe("ordered");
  });

  it("is a clerk action only", async () => {
    const id = await processEmail(db, raw25, null, new FakeLlm(JSON.stringify(email25())), ref);
    expect((await post(`/requisitions/${id}/order`, "EMP-501")).status).toBe(403);
  });
});

describe("creating a supplier through the UI", () => {
  it("shows the form for an unknown supplier and is a clerk action only", async () => {
    const x = email25();
    x.supplier_name = { value: "Stahlhandel Wyss AG", evidence: null };
    x.supplier_vat_id = { value: null, evidence: null };
    const id = await processEmail(db, raw25, null, new FakeLlm(JSON.stringify(x)), ref);

    const page = await (await fetch(`${base}/requisitions/${id}`, { headers: { cookie: "actAs=clerk" } })).text();
    expect(page).toContain(`action="/requisitions/${id}/create-supplier"`);
    expect(page).toContain('value="Stahlhandel Wyss AG"'); // pre-filled, for the clerk to check

    const form = { name: "Stahlhandel Wyss AG", vatId: "", country: "CH", currency: "CHF", paymentTermsDays: "30" };
    expect((await post(`/requisitions/${id}/create-supplier`, "EMP-103", form)).status).toBe(403);
    const created = await post(`/requisitions/${id}/create-supplier`, "clerk", form);
    expect(created.page).toContain("Supplier created and set");
  });
});
