import { z } from "zod";

// Values a clerk entered by hand. They replace the model's claim for that field
// and count as trusted (a person decided, and the audit log says who). They go
// through the same checks as everything else: a blocked supplier still blocks.
//
// Form input is an external input, so it is validated with zod. `.strict()`
// rejects unknown keys, so a typo can't silently do nothing.

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const LineOverride = z
  .object({
    description: z.string().trim().min(1).optional(),
    itemCode: z.string().trim().min(1).nullable().optional(),
    quantity: z.number().positive().optional(),
    unit: z.string().trim().min(1).optional(),
    unitPrice: z.number().optional(), // 0 is allowed (free of charge); negative for a discount line
    pricePer: z.number().positive().nullable().optional(),
  })
  .strict();

export const ClerkOverridesSchema = z
  .object({
    supplierId: z.string().optional(),
    costCenterCode: z.string().trim().toUpperCase().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    requestedDeliveryDate: z.string().regex(isoDate).refine((s) => !Number.isNaN(Date.parse(s)), "not a real date").optional(),
    // Keyed by line index ("0", "1", …) because JSON object keys are strings.
    // An index past the extracted lines adds a new line.
    lines: z.record(z.string().regex(/^\d+$/), LineOverride).optional(),
  })
  .strict();

export type ClerkOverrides = z.infer<typeof ClerkOverridesSchema>;
export type LineOverride = z.infer<typeof LineOverride>;

/** Which extracted fields an override replaces, so their "unverified" flags no longer apply. */
export function overriddenFields(ov: ClerkOverrides): Set<string> {
  const fields = new Set<string>();
  if (ov.supplierId !== undefined) fields.add("supplier_name").add("supplier_vat_id");
  if (ov.costCenterCode !== undefined) fields.add("cost_center_code").add("cost_center_name");
  if (ov.currency !== undefined) fields.add("currency");
  if (ov.requestedDeliveryDate !== undefined) fields.add("requested_delivery").add("requested_delivery.iso").add("requested_delivery.text");
  for (const [index, l] of Object.entries(ov.lines ?? {})) {
    const p = `line_items[${index}]`;
    if (l.description !== undefined) fields.add(`${p}.description`);
    if (l.itemCode !== undefined) fields.add(`${p}.item_code`);
    if (l.quantity !== undefined) fields.add(`${p}.quantity`);
    if (l.unit !== undefined) fields.add(`${p}.unit`);
    if (l.unitPrice !== undefined) fields.add(`${p}.unit_price`);
    if (l.pricePer !== undefined) fields.add(`${p}.price_per`);
    if (editsFigures(l)) fields.add(`${p}.line_total`); // the document's line total no longer applies
    if (l.quantity !== undefined && l.unitPrice !== undefined && l.description !== undefined) fields.add(p);
  }
  return fields;
}

export function editsFigures(l: LineOverride): boolean {
  return l.quantity !== undefined || l.unitPrice !== undefined || l.pricePer !== undefined;
}
