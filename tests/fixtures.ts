import type { ErpClient, ErpResult, PurchaseOrderRequest } from "../src/erp/poClient.ts";
import type { ChatMessage, LlmClient } from "../src/extract/llm.ts";
import type { Extraction } from "../src/extract/schema.ts";

// Shared test data.

/** A correct extraction of email 25, as a good model would return it. */
export function email25(): Extraction {
  const none = { value: null, evidence: null };
  return {
    requester_name: { value: "Miriam Frick", evidence: "From: Miriam Frick <miriam.frick@customer.com>" },
    requester_email: { value: "miriam.frick@customer.com", evidence: "From: Miriam Frick <miriam.frick@customer.com>" },
    supplier_name: { value: "TechnoPlast Kunststoffe GmbH", evidence: "TechnoPlast Kunststoffe GmbH" },
    supplier_vat_id: { value: "DE667788990", evidence: "UID: DE667788990" },
    cost_center_code: { value: "CC-1003", evidence: "Kostenstelle CC-1003" },
    cost_center_name: none,
    currency: { value: "EUR", evidence: "Total: 3,150.00 EUR" },
    line_items: [
      {
        description: "Kunststoffclip KC-8, schwarz",
        item_code: "KC-8-SW",
        quantity: 15000,
        unit: "Stk",
        unit_price: 21,
        price_per: 100,
        line_total: 3150,
        // Spans a line break in the PDF text; whitespace is normalised when matching.
        evidence: "1 Kunststoffclip KC-8, schwarz Art.-Nr. KC-8-SW 15000 Stk 21.00 / 100 3,150.00",
      },
    ],
    net_total: { value: 3150, evidence: "Zwischensumme: 3,150.00 EUR" },
    vat_amount: { value: 0, evidence: "USt (0%, innergemeinschaftliche Lieferung): 0.00 EUR" },
    gross_total: { value: 3150, evidence: "Total: 3,150.00 EUR" },
    total_unlabelled: none,
    requested_delivery: { text: "bis Ende Mai", iso: null, evidence: "Lieferung bis Ende Mai" },
    quote_valid_until: { text: "12.06.2026", iso: "2026-06-12", evidence: "Gültig bis: 12.06.2026" },
    quote_number: { value: "TP-26-0884", evidence: "Offert-Nr.: TP-26-0884" },
    referenced_requests: [],
    notes_for_clerk: [],
  };
}

/** Replays scripted answers and records every call, so tests never need Ollama. */
export class FakeLlm implements LlmClient {
  readonly name = "fake";
  calls: ChatMessage[][] = [];
  private answers: (string | Error)[];

  constructor(...answers: (string | Error)[]) {
    this.answers = answers;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    this.calls.push(structuredClone(messages));
    const next = this.answers.shift();
    if (next === undefined) throw new Error("FakeLlm: no answer left");
    if (next instanceof Error) throw next;
    return next;
  }
}

/** A correct extraction of email 23 (Andrea Roth requests on her own CC-1004, EUR 7,200). */
export function email23(): Extraction {
  const none = { value: null, evidence: null };
  const noDate = { text: null, iso: null, evidence: null };
  return {
    requester_name: { value: "Andrea Roth", evidence: "From: Andrea Roth <andrea.roth@customer.com>" },
    requester_email: { value: "andrea.roth@customer.com", evidence: "From: Andrea Roth <andrea.roth@customer.com>" },
    supplier_name: { value: "Bergmann Werkzeugbau", evidence: "bitte bei Bergmann Werkzeugbau bestellen:" },
    supplier_vat_id: none,
    cost_center_code: { value: "CC-1004", evidence: "Kostenstelle CC-1004." },
    cost_center_name: none,
    currency: { value: "EUR", evidence: "3 Stk Vorrichtungsplatte VP-500, je EUR 1'600.00" },
    line_items: [
      { description: "Vorrichtungsplatte VP-500", item_code: "VP-500", quantity: 3, unit: "Stk", unit_price: 1600,
        price_per: null, line_total: null, evidence: "3 Stk Vorrichtungsplatte VP-500, je EUR 1'600.00" },
      { description: "Zentrierbolzen ZB-16", item_code: "ZB-16", quantity: 4, unit: "Satz", unit_price: 600,
        price_per: null, line_total: null, evidence: "4 Satz Zentrierbolzen ZB-16, je EUR 600.00" },
    ],
    net_total: none,
    vat_amount: none,
    gross_total: none,
    total_unlabelled: { value: 7200, evidence: "Total EUR 7'200.00." },
    requested_delivery: noDate,
    quote_valid_until: noDate,
    quote_number: none,
    referenced_requests: [],
    notes_for_clerk: [],
  };
}

// Re-exported so tests keep one import line.
export { emptyExtraction } from "../src/extract/schema.ts";

/** Records every order and answers with scripted results (default: booked, no warnings). */
export class FakeErp implements ErpClient {
  orders: { order: PurchaseOrderRequest; key: string }[] = [];
  private results: (ErpResult | Error)[];
  constructor(...results: (ErpResult | Error)[]) {
    this.results = results;
  }
  async createPurchaseOrder(order: PurchaseOrderRequest, key: string): Promise<ErpResult> {
    this.orders.push({ order, key });
    const next = this.results.shift() ?? { kind: "booked", poNumber: `PO-TEST-${this.orders.length}`, warnings: [], alreadyBooked: false };
    if (next instanceof Error) throw next;
    return next;
  }
}
