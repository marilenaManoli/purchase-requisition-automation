import { z } from "zod";

// The customer's ERP (data/mock_po_api.py) behind an interface, like the LLM:
// a real ERP connection would be a second implementation, and tests use a fake.

export interface PurchaseOrderLine {
  item_name: string;
  quantity: number;
  unit_price: number; // per single unit: the ERP has no "price per 100"
  unit: string;
  item_code?: string;
}

export interface PurchaseOrderRequest {
  supplier_id: string;
  currency: string;
  total: number; // NET; VAT stays in our database (the ERP would add tax_amount to the line sum)
  requested_delivery_date: string; // YYYY-MM-DD
  cost_centre?: string;
  gl_account?: string;
  requisition_reference: string;
  line_items: PurchaseOrderLine[];
}

export type ErpResult =
  | { kind: "booked"; poNumber: string; warnings: string[]; alreadyBooked: boolean }
  | { kind: "rejected"; problems: string[]; warnings: string[] };

export interface ErpClient {
  /** Throws only when the ERP can't be reached; a rejection is a normal result. */
  createPurchaseOrder(order: PurchaseOrderRequest, idempotencyKey: string): Promise<ErpResult>;
}

// The ERP's answers are external input: validated before use.
const Booked = z.object({
  po_number: z.string().min(1),
  requisition_reference: z.string().nullable().optional(),
  warnings: z.array(z.string()).optional(),
});
const Rejected = z.object({ problems: z.array(z.string()), warnings: z.array(z.string()).optional() });

export class HttpErpClient implements ErpClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async createPurchaseOrder(order: PurchaseOrderRequest, idempotencyKey: string): Promise<ErpResult> {
    const res = await fetch(`${this.baseUrl}/purchase-orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(order),
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await res.json().catch(() => null);

    if (res.status === 201 || res.status === 200) {
      // 200 = this Idempotency-Key was booked before: the same order comes back, not a second one.
      const booked = Booked.parse(body);
      if (booked.requisition_reference && booked.requisition_reference !== order.requisition_reference) {
        throw new Error("The ERP returned an order for a different requisition");
      }
      return { kind: "booked", poNumber: booked.po_number, warnings: booked.warnings ?? [], alreadyBooked: res.status === 200 };
    }
    if (res.status === 422) {
      const rejected = Rejected.parse(body);
      return { kind: "rejected", problems: rejected.problems, warnings: rejected.warnings ?? [] };
    }
    throw new Error(`The ERP answered HTTP ${res.status}`);
  }
}
