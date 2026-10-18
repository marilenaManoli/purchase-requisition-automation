import type { Extraction } from "./schema.ts";

// ---------------------------------------------------------------------------
// The evidence check: a value from the model is only trusted when
//   (a) its evidence quote really appears in the source text, and
//   (b) the value can be read from that quote.
// Anything failing either test is reported as unverified. It is never
// silently dropped or corrected: the clerk sees the value and the reason.
// ---------------------------------------------------------------------------

export interface UnverifiedValue {
  field: string; // e.g. "net_total", "line_items[1].unit_price"
  reason: "missing_evidence" | "quote_not_in_source" | "value_not_in_quote";
}

/**
 * Makes text comparable despite cosmetic differences: case, runs of
 * whitespace/newlines, typographic quotes and the Unicode minus sign.
 */
export function normaliseForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’´`]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/−/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Notations a number can be written in. A string may fit several
// ("1.000" is 1000 in German, 1 in English), and we accept every reading that
// fits: we only need to know whether the model's number is *a* valid reading
// of the quote, not which notation the author meant.
const SWISS = /^\d{1,3}('\d{3})+(\.\d+)?$/; // 3'200.00
const ENGLISH = /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/; // 3,150.00  or  3150.5
const GERMAN = /^(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/; // 1.234,50  or  21,00

/** Every number that a piece of text can plausibly be read as containing. */
export function numbersIn(text: string): number[] {
  const normalised = normaliseForMatch(text);
  const results: number[] = [];
  for (const match of normalised.matchAll(/-?\d+(?:['.,]\d+)*/g)) {
    let token = match[0];
    let sign = 1;
    if (token.startsWith("-")) {
      token = token.slice(1);
      // "CC-1003" or "KC-8": a hyphen right after a letter or digit is not a minus sign.
      const charBefore = normalised[match.index - 1] ?? "";
      if (!/[\p{L}\p{N}]/u.test(charBefore)) sign = -1;
    }
    if (SWISS.test(token)) results.push(sign * Number(token.replace(/'/g, "")));
    if (ENGLISH.test(token)) results.push(sign * Number(token.replace(/,/g, "")));
    if (GERMAN.test(token)) results.push(sign * Number(token.replace(/\./g, "").replace(",", ".")));
  }
  return results;
}

const AMOUNT_TOLERANCE = 0.005; // half a cent: guards against float noise only

function numberInQuote(value: number, quote: string): boolean {
  return numbersIn(quote).some((n) => Math.abs(n - value) < AMOUNT_TOLERANCE);
}

function textInQuote(value: string, quote: string): boolean {
  return normaliseForMatch(quote).includes(normaliseForMatch(value));
}

const CURRENCY_SYMBOLS: Record<string, string[]> = {
  EUR: ["€", "euro"],
  USD: ["$", "dollar"],
  GBP: ["£", "pound"],
  CHF: ["fr.", "sfr", "franken"],
};

function currencyInQuote(code: string, quote: string): boolean {
  const q = normaliseForMatch(quote);
  return q.includes(code.toLowerCase()) || (CURRENCY_SYMBOLS[code] ?? []).some((s) => q.includes(s));
}

const MONTHS = [
  ["january", "januar", "jan"], ["february", "februar", "feb"], ["march", "märz", "maerz", "mar"],
  ["april", "apr"], ["may", "mai"], ["june", "juni", "jun"], ["july", "juli", "jul"],
  ["august", "aug"], ["september", "sept", "sep"], ["october", "oktober", "oct", "okt"],
  ["november", "nov"], ["december", "dezember", "dec", "dez"],
];

/** Does the quote contain the ISO date in a common written form? */
function dateInQuote(iso: string, quote: string): boolean {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return false;
  const q = normaliseForMatch(quote);
  const day = String(Number(d));
  const month = String(Number(m));
  const numeric = [`${d}.${m}.${y}`, `${day}.${month}.${y}`, iso, `${d}/${m}/${y}`, `${day}/${month}/${y}`];
  if (numeric.some((form) => q.includes(form))) return true;
  // "30 June 2026", "30. Juni 2026", "June 30, 2026"
  const names = MONTHS[Number(m) - 1] ?? [];
  return q.includes(y) && names.some((name) => new RegExp(`\\b${day}\\.? ${name}\\b|\\b${name} ${day}\\b`).test(q));
}

/** Checks every extracted value against the exact source text the model saw. */
export function findUnverifiedValues(x: Extraction, sourceText: string): UnverifiedValue[] {
  const source = normaliseForMatch(sourceText);
  const problems: UnverifiedValue[] = [];

  // One evidence quote supporting one or more values. `valueChecks` are the
  // individual "can this value be read from the quote?" tests, by field name.
  function check(field: string, evidence: string | null, hasValue: boolean, valueChecks: Record<string, boolean>) {
    if (!hasValue) return; // nothing claimed, nothing to verify
    if (evidence === null || evidence.trim() === "") {
      problems.push({ field, reason: "missing_evidence" });
    } else if (!source.includes(normaliseForMatch(evidence))) {
      problems.push({ field, reason: "quote_not_in_source" });
    } else {
      for (const [name, ok] of Object.entries(valueChecks)) {
        if (!ok) problems.push({ field: name, reason: "value_not_in_quote" });
      }
    }
  }

  // Simple text fields: the value must appear in its own quote.
  const textFields = [
    "requester_name", "requester_email", "supplier_name", "supplier_vat_id",
    "cost_center_code", "cost_center_name", "quote_number",
  ] as const; // `as const` makes this a tuple of exact string literals, so x[f] is typed
  for (const f of textFields) {
    const { value, evidence } = x[f];
    check(f, evidence, value !== null, { [f]: value !== null && evidence !== null && textInQuote(value, evidence) });
  }

  {
    const { value, evidence } = x.currency;
    check("currency", evidence, value !== null, {
      currency: value !== null && evidence !== null && currencyInQuote(value, evidence),
    });
  }

  for (const f of ["net_total", "vat_amount", "gross_total", "total_unlabelled"] as const) {
    const { value, evidence } = x[f];
    check(f, evidence, value !== null, { [f]: value !== null && evidence !== null && numberInQuote(value, evidence) });
  }

  for (const f of ["requested_delivery", "quote_valid_until"] as const) {
    const { text, iso, evidence } = x[f];
    check(f, evidence, text !== null || iso !== null, {
      [`${f}.text`]: text === null || (evidence !== null && textInQuote(text, evidence)),
      [`${f}.iso`]: iso === null || (evidence !== null && dateInQuote(iso, evidence)),
    });
  }

  x.line_items.forEach((item, i) => {
    const p = `line_items[${i}]`;
    const q = item.evidence;
    const num = (v: number | null) => v === null || numberInQuote(v, q);
    const txt = (v: string | null) => v === null || textInQuote(v, q);
    check(p, q, true, {
      [`${p}.description`]: txt(item.description),
      [`${p}.item_code`]: txt(item.item_code),
      [`${p}.unit`]: txt(item.unit),
      [`${p}.quantity`]: num(item.quantity),
      [`${p}.unit_price`]: num(item.unit_price),
      [`${p}.price_per`]: item.price_per === null || item.price_per === 1 || num(item.price_per),
      [`${p}.line_total`]: num(item.line_total),
    });
  });

  x.referenced_requests.forEach((r, i) => {
    check(`referenced_requests[${i}]`, r.evidence, true, {
      [`referenced_requests[${i}]`]: textInQuote(r.value, r.evidence),
    });
  });

  // Notes are the model's own summary, so only their quote is checked.
  x.notes_for_clerk.forEach((n, i) => check(`notes_for_clerk[${i}]`, n.evidence, n.evidence !== null, {}));

  return problems;
}
