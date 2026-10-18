import { issue } from "../checks/issues.ts";
import { ClerkOverridesSchema } from "../checks/overrides.ts";
import { round2 } from "../checks/money.ts";
import type { Db } from "../db/db.ts";
import type { ErpClient, PurchaseOrderRequest } from "../erp/poClient.ts";
import { ApprovalError } from "./approvals.ts";
import { nowIso, writeAudit, type Actor } from "./audit.ts";
import { requisitionNumber } from "./duplicates.ts";
import { saveIssues } from "./processEmail.ts";
import { getState, transition } from "./transitions.ts";

// Step 8: an approved requisition becomes a purchase order in the ERP
// (brief §8). Only from `approved`; the ERP assigns the PO number.

/**
 * The delivery date is the one value the clerk may set after approval: it doesn't
 * change what is bought or for how much, which is what the approvers approved,
 * and the ERP requires it (brief §6: most emails don't state one). Audited.
 */
export function setDeliveryDate(db: Db, id: number, actor: Actor, date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new ApprovalError("Enter the delivery date as YYYY-MM-DD.");
  }
  db.transaction(() => {
    const state = getState(db, id);
    if (state === "ordered" || state === "rejected") throw new ApprovalError(`The delivery date can't be changed in state ${state}.`);
    const row = db.prepare(`SELECT requested_delivery_date, clerk_overrides_json FROM requisitions WHERE id = ?`).get(id) as
      { requested_delivery_date: string | null; clerk_overrides_json: string | null };
    const overrides = row.clerk_overrides_json ? ClerkOverridesSchema.parse(JSON.parse(row.clerk_overrides_json)) : {};
    db.prepare(`UPDATE requisitions SET requested_delivery_date = ?, clerk_overrides_json = ?, updated_at = ? WHERE id = ?`)
      .run(date, JSON.stringify({ ...overrides, requestedDeliveryDate: date }), nowIso(), id);
    db.prepare(`UPDATE issues SET resolved_at = ?, resolved_by = ?, resolution = ?
                WHERE requisition_id = ? AND code IN ('DELIVERY_DATE_MISSING', 'DELIVERY_DATE_IN_PAST') AND resolved_at IS NULL`)
      .run(nowIso(), actor, `Delivery date set to ${date}`, id);
    writeAudit(db, id, actor, state, state, `Clerk set requestedDeliveryDate: ${JSON.stringify(row.requested_delivery_date)} → "${date}"`);
  })();
}

/** Builds the ERP request from what is ESTABLISHED in the database (never from the raw extraction). */
export function buildPurchaseOrder(db: Db, id: number): { order: PurchaseOrderRequest; idempotencyKey: string } {
  const r = db.prepare(
    `SELECT id, created_at, supplier_id, currency, net_total, requested_delivery_date, cost_center_code, gl_account_code
     FROM requisitions WHERE id = ?`,
  ).get(id) as {
    id: number; created_at: string; supplier_id: string | null; currency: string | null; net_total: number | null;
    requested_delivery_date: string | null; cost_center_code: string | null; gl_account_code: string | null;
  };
  if (r.requested_delivery_date === null) {
    throw new ApprovalError("The ERP needs a requested delivery date. Enter it before ordering.");
  }
  if (r.supplier_id === null || r.currency === null || r.net_total === null) {
    throw new ApprovalError("Supplier, currency and amount must be established before ordering.");
  }

  const lines = db.prepare(`SELECT description, item_code, quantity, unit, unit_price, price_per FROM line_items WHERE requisition_id = ? ORDER BY position`)
    .all(id) as { description: string; item_code: string | null; quantity: number | null; unit: string | null; unit_price: number | null; price_per: number }[];

  const number = requisitionNumber(r.id, r.created_at);
  return {
    order: {
      supplier_id: r.supplier_id,
      currency: r.currency,
      total: round2(r.net_total),
      requested_delivery_date: r.requested_delivery_date,
      ...(r.cost_center_code ? { cost_centre: r.cost_center_code } : {}),
      ...(r.gl_account_code ? { gl_account: r.gl_account_code } : {}),
      requisition_reference: number,
      line_items: lines.map((l) => ({
        item_name: l.description,
        quantity: l.quantity ?? 0, // can't be null here: an approved requisition has every line totalled
        // "21.00 per 100" → 0.21 per piece, so the ERP's quantity × price matches the total.
        unit_price: (l.unit_price ?? 0) / l.price_per,
        unit: l.unit ?? "",
        ...(l.item_code ? { item_code: l.item_code } : {}),
      })),
    },
    // Number + creation time: unique even if our database is re-seeded while the ERP keeps its memory.
    idempotencyKey: `${number}@${r.created_at}`,
  };
}

/** Sends an approved requisition to the ERP. Booked → ordered; rejected → stays approved, problems shown. */
export async function sendToErp(db: Db, id: number, actor: Actor, erp: ErpClient): Promise<{ poNumber: string; warnings: string[] }> {
  if (getState(db, id) !== "approved") throw new ApprovalError("Only an approved requisition can be sent to the ERP.");
  const { order, idempotencyKey } = buildPurchaseOrder(db, id);

  let result;
  try {
    result = await erp.createPurchaseOrder(order, idempotencyKey);
  } catch (err) {
    // Unreachable or an unexpected answer: nothing changed, and a retry is safe (same Idempotency-Key).
    throw new ApprovalError(`The ERP could not be reached or answered unexpectedly (${err instanceof Error ? err.message : "unknown"}). Try again.`);
  }

  if (result.kind === "rejected") {
    db.transaction(() => {
      saveIssues(db, id, [issue("ERP_REJECTED", "blocks_order", null, `The ERP rejected the order: ${result.problems.join("; ")}`)]);
      writeAudit(db, id, actor, "approved", "approved", `ERP rejected the order (${result.problems.length} problem(s))`);
    })();
    throw new ApprovalError(`The ERP rejected the order: ${result.problems.join("; ")}. Pull it back to correct it; it will need re-approval.`);
  }

  db.transaction(() => {
    db.prepare(`UPDATE requisitions SET erp_po_number = ?, erp_warnings_json = ?, updated_at = ? WHERE id = ?`)
      .run(result.poNumber, JSON.stringify(result.warnings), nowIso(), id);
    db.prepare(`UPDATE issues SET resolved_at = ?, resolved_by = ?, resolution = 'Order booked' WHERE requisition_id = ? AND code = 'ERP_REJECTED' AND resolved_at IS NULL`)
      .run(nowIso(), actor, id);
    saveIssues(db, id, result.warnings.map((w) => issue("ERP_WARNING", "warning", null, `ERP: ${w}`)));
    transition(db, id, "ordered", actor,
      `Booked in the ERP as ${result.poNumber}${result.alreadyBooked ? " (already booked earlier)" : ""}${result.warnings.length ? `, ${result.warnings.length} warning(s)` : ""}`);
  })();
  return { poNumber: result.poNumber, warnings: result.warnings };
}
