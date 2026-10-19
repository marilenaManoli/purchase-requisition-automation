import { z } from "zod";
import { normaliseCompanyName, normaliseVatId } from "../checks/supplier.ts";
import type { Db } from "../db/db.ts";
import type { ReferenceData, SupplierRow } from "../db/queries.ts";
import { ApprovalError } from "./approvals.ts";
import { writeAudit, type Actor } from "./audit.ts";
import { editRequisition } from "./edits.ts";
import { getState } from "./transitions.ts";

// Brief §6: an unknown supplier is shown to the clerk "with the option to create
// it", but a supplier record is never invented from what the model extracted.
// So creation is an explicit clerk action with values the clerk confirmed (the
// form is only pre-filled from the email), and it refuses duplicates.

// Form input is an external input.
const NewSupplierSchema = z.object({
  name: z.string().trim().min(2),
  vatId: z.string().trim().transform((v) => (v === "" ? null : v)), // empty = no VAT ID (like SUP-019)
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "must be a 2-letter country code"),
  currency: z.string().trim().toUpperCase(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365),
});

/** Creates a supplier and sets it on the requisition (which is then re-checked). Returns the new id. */
export async function createSupplierForRequisition(
  db: Db, id: number, actor: Actor, input: unknown, ref: ReferenceData,
): Promise<string> {
  if (getState(db, id) !== "needs_review") throw new ApprovalError("Suppliers can only be created while the requisition is in review.");
  const parsed = NewSupplierSchema.safeParse(input);
  if (!parsed.success) throw new ApprovalError(`Invalid supplier: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const s = parsed.data;
  if (!ref.fxRatesToChf.has(s.currency)) throw new ApprovalError(`Unsupported currency ${s.currency}.`);

  // Never a second record for an existing supplier: the clerk should pick that one.
  const existing = ref.suppliers.find((x) =>
    (s.vatId !== null && x.vat_id !== null && normaliseVatId(x.vat_id) === normaliseVatId(s.vatId)) ||
    normaliseCompanyName(x.name) === normaliseCompanyName(s.name));
  if (existing) throw new ApprovalError(`${existing.id} ${existing.name} already exists with this name or VAT ID. Select it instead of creating a new one.`);

  const next = Math.max(0, ...ref.suppliers.map((x) => Number(x.id.replace("SUP-", "")) || 0)) + 1;
  const row: SupplierRow = { id: `SUP-${String(next).padStart(3, "0")}`, name: s.name, vat_id: s.vatId, default_currency: s.currency, status: "active" };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO suppliers (id, name, vat_id, country, default_currency, payment_terms_days, preferred, status)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'active')`,
    ).run(row.id, row.name, row.vat_id, s.country, row.default_currency, s.paymentTermsDays);
    writeAudit(db, id, actor, "needs_review", "needs_review",
      `Clerk created supplier ${row.id} "${row.name}" (VAT ID ${row.vat_id ?? "none"}, ${s.country}, ${row.default_currency})`);
  })();
  ref.suppliers.push(row); // the app keeps master data in memory: make the new supplier visible at once

  await editRequisition(db, id, actor, { supplierId: row.id }, ref); // audited override + re-check
  return row.id;
}
