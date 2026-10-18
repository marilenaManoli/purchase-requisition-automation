// HTML forms send every value as a string, and an empty field means "leave as
// it is". These helpers turn a form body into the plain object that zod then
// validates (ClerkOverridesSchema). They don't validate themselves: anything
// that isn't a clean number stays a string, so zod rejects it with a message.

type FormBody = Record<string, unknown>;

const LINE_FIELDS = ["description", "itemCode", "quantity", "unit", "unitPrice", "pricePer"] as const;
const NUMERIC = new Set(["quantity", "unitPrice", "pricePer"]);

/** "1'600.00" or "1600" → 1600; "abc" stays "abc" (zod will reject it). */
function toNumber(value: string): number | string {
  const cleaned = value.replace(/['\s]/g, "");
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : value;
}

function text(body: FormBody, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Edit form → overrides. Line fields are named like "line.0.unitPrice". */
export function parseEditForm(body: FormBody): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["supplierId", "costCenterCode", "currency", "requestedDeliveryDate"]) {
    const v = text(body, key);
    if (v !== undefined) result[key] = v;
  }

  const lines: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(body)) {
    const match = /^line\.(\d+)\.(\w+)$/.exec(key);
    if (!match) continue;
    const [, index, field] = match as unknown as [string, string, (typeof LINE_FIELDS)[number]];
    if (!LINE_FIELDS.includes(field)) continue;
    const v = text(body, key);
    if (v === undefined) continue;
    (lines[index] ??= {})[field] = NUMERIC.has(field) ? toNumber(v) : v; // ??= assigns only if undefined
  }
  if (Object.keys(lines).length > 0) result.lines = lines;
  return result;
}

/** Assignment selects are named "assign.<step position>". */
export function parseAssignments(body: FormBody): Record<number, string> {
  const result: Record<number, string> = {};
  for (const key of Object.keys(body)) {
    const match = /^assign\.(\d+)$/.exec(key);
    const v = text(body, key);
    if (match && v !== undefined) result[Number(match[1])] = v;
  }
  return result;
}
