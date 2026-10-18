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
