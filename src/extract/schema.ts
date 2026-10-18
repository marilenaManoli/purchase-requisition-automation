import { z } from "zod";

// ---------------------------------------------------------------------------
// What the LLM must return. This one zod schema is used three ways:
//   1. z.toJSONSchema(...) is sent to Ollama, which constrains generation to it;
//   2. .safeParse(...) validates whatever actually comes back;
//   3. z.infer<...> gives us the TypeScript type.
//
// Every value is paired with `evidence`: a short verbatim quote from the
// source. Code checks the quote exists and that the value can be read from it
// (src/extract/evidence.ts). A value the document doesn't state is null.
//
// Refinements (.refine) are checked by zod but don't appear in the JSON
// schema, so the schema the model sees stays simple.
// ---------------------------------------------------------------------------

const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/**
 * A generic helper: `evidenced(z.number())` builds { value: number | null, evidence: string | null }.
 * `<T extends z.ZodType>` means "any zod schema", and the result keeps T's exact type.
 */
function evidenced<T extends z.ZodType>(value: T) {
  return z.object({ value: value.nullable(), evidence: z.string().nullable() });
}

const Text = evidenced(z.string().min(1));
const Amount = evidenced(z.number());
const Currency = evidenced(z.string().refine((s) => /^[A-Z]{3}$/.test(s), "must be an ISO code like EUR"));

const DateField = z.object({
  text: z.string().nullable(), // as written: "bis Ende Mai", "30.06.2026"
  iso: z.string().refine(isIsoDate, "must be YYYY-MM-DD").nullable(), // only for an exact date
  evidence: z.string().nullable(),
});

const LineItem = z.object({
  description: z.string().min(1),
  item_code: z.string().nullable(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  unit_price: z.number().nullable(), // null = no price stated
  price_per: z.number().positive().nullable(), // 100 for "21.00 / 100"; null = per single unit
  line_total: z.number().nullable(),
  evidence: z.string().min(1), // the line as written in the document
});

export const ExtractionSchema = z.object({
  requester_name: Text,
  requester_email: Text,
  supplier_name: Text,
  supplier_vat_id: Text,
  cost_center_code: Text,
  cost_center_name: Text, // e.g. "London office" when no code is given; a hint only
  currency: Currency,
  line_items: z.array(LineItem),
  net_total: Amount, // labelled as excluding VAT / subtotal / netto
  vat_amount: Amount,
  gross_total: Amount, // labelled as including VAT / brutto
  total_unlabelled: Amount, // a total whose VAT status the document doesn't state
  requested_delivery: DateField,
  quote_valid_until: DateField,
  quote_number: Text,
  referenced_requests: z.array(z.object({ value: z.string().min(1), evidence: z.string().min(1) })),
  notes_for_clerk: z.array(z.object({ note: z.string().min(1), evidence: z.string().nullable() })),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedLineItem = z.infer<typeof LineItem>;

/** The JSON schema handed to the model (Ollama's `format` parameter). */
export const extractionJsonSchema = z.toJSONSchema(ExtractionSchema);
