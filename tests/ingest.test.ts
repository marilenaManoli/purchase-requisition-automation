import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEmail } from "../src/ingest/parseEmail.ts";
import { pdfToText } from "../src/ingest/pdfText.ts";
import { renderSourceText } from "../src/ingest/sourceDocument.ts";

const sample = (name: string) => parseEmail(readFileSync(`data/emails/${name}`));

describe("parseEmail", () => {
  it("reads a plain-text email with a PDF quote (email 25)", async () => {
    const doc = await sample("email_25.eml");

    expect(doc.bodyFormat).toBe("text");
    expect(doc.fromEmail).toBe("miriam.frick@customer.com");
    expect(doc.sentAt).toBe("2026-05-14T05:30:00.000Z");
    expect(doc.body).toContain("Kostenstelle CC-1003");
    expect(doc.attachments).toHaveLength(1);
    expect(doc.attachments[0]).toMatchObject({ filename: "quote_technoplast_per100.pdf", pages: 1, problem: null });
    // The per-100 price must survive extraction intact (trap case 25).
    expect(doc.attachments[0]?.text).toContain("15000 Stk 21.00 / 100 3,150.00");
  });

  it("converts an HTML-only body to text, keeping table rows together (email 49)", async () => {
    const doc = await sample("email_49.eml");

    expect(doc.bodyFormat).toBe("html");
    expect(doc.body).not.toMatch(/<[a-z]/i); // no tags left
    expect(doc.body).toMatch(/Kostenstelle:\s+CC-4002/);
    expect(doc.body).toMatch(/Gewuenschte Lieferung:\s+bis 30\.06\.2026/);
    expect(doc.body).toContain("Messraum 1"); // &nbsp; decoded
  });

  it("converts an HTML-only email itself, ignoring mailparser's invented text (found in rehearsal)", async () => {
    const eml = [
      "From: ruedi.zimmermann@customer.com",
      "Subject: Kalibrierung",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><table border=\"1\">",
      "<tr><th>Pos</th><th>Beschreibung</th><th>Menge</th><th>Preis CHF</th></tr>",
      "<tr><td>1</td><td>Kalibrierung Multimeter</td><td>10</td><td>300.00</td></tr>",
      "</table></body></html>",
    ].join("\r\n");
    const doc = await parseEmail(Buffer.from(eml));
    expect(doc.bodyFormat).toBe("html");
    expect(doc.body).toMatch(/1\s+Kalibrierung Multimeter\s+10\s+300\.00/);
    expect(doc.body).not.toContain("Multimeter10");
  });

  it("records no attachment when the body only claims one (email 01)", async () => {
    const doc = await sample("email_01_clean_with_pdf.eml");

    expect(doc.attachments).toEqual([]);
    expect(doc.body).toContain("[Attachment: quote_acme_bearings.pdf]");
  });

  it("decodes quoted-printable soft line breaks in a forwarded thread (email 45)", async () => {
    const doc = await sample("email_45.eml");

    expect(doc.body).toContain("Bottom of the chain has the actual numbers.");
    expect(doc.body).toContain("Total:                41,200.00 EUR");
  });

  it("does not throw on input that is not an email", async () => {
    const doc = await parseEmail(Buffer.from(""));

    expect(doc.bodyFormat).toBe("none");
    expect(doc.fromEmail).toBeNull();
    expect(doc.sentAt).toBeNull();
    expect(doc.warnings).toEqual(["No readable content: empty body and no readable attachment"]);
  });

  it("does not read attachments that are not PDFs, and says why", async () => {
    const eml = [
      "From: someone@customer.com",
      "Subject: test",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "Please order, see sheet.",
      "--b",
      "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      'Content-Disposition: attachment; filename="order.xlsx"',
      "Content-Transfer-Encoding: base64",
      "",
      "UEsDBA==",
      "--b--",
    ].join("\r\n");

    const doc = await parseEmail(Buffer.from(eml));

    expect(doc.attachments[0]).toMatchObject({ filename: "order.xlsx", text: null });
    expect(doc.attachments[0]?.problem).toMatch(/out of scope/);
  });
});

describe("pdfToText", () => {
  it("returns a reason instead of throwing for bytes that are not a PDF", async () => {
    const result = await pdfToText(new Uint8Array([1, 2, 3, 4]));
    expect(result).toEqual({ ok: false, reason: "PDF could not be read (damaged or encrypted)" });
  });
});

describe("renderSourceText", () => {
  it("contains headers, body and every attachment, in that order", async () => {
    const text = renderSourceText(await sample("email_25.eml"));

    expect(text.startsWith("From: Miriam Frick <miriam.frick@customer.com>\nSubject: ")).toBe(true);
    const body = text.indexOf("--- EMAIL BODY ---");
    const pdf = text.indexOf("--- ATTACHMENT 1: quote_technoplast_per100.pdf (application/pdf) ---");
    expect(body).toBeGreaterThan(0);
    expect(pdf).toBeGreaterThan(body);
    expect(text).toContain("Offert-Nr.: TP-26-0884");
  });
});
