import type { Extraction } from "./schema.ts";

// ---------------------------------------------------------------------------
// The evidence check: a value from the model is only trusted when
//   (a) every line of its evidence quote really appears in the source text, and
//   (b) the value can be read from ONE contiguous passage of that quote.
// (b) tolerates extra real lines the model likes to include (a table header
// above the row) but still catches values stitched from different places.
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

// Words that make the number after them approximate: "ca. 50", "so um die 4 EUR", "~120".
const HEDGE_BEFORE = /(?:\b(?:ca|circa|zirka|approx|approximately|about|around|roughly|ungef(?:ä|ae)hr|etwa|rund)\b\.?|\bum die\b|~)\s*(?:[a-z]{3}\s*)?$/i;

/**
 * True if the quote states this number only approximately: a hedge word right
 * before it (only a currency code may sit in between). Such a number passes the
 * evidence check, because it IS in the quote, but it's still not a fact.
 */
export function isApproximate(value: number, quote: string): boolean {
  const text = normaliseForMatch(quote);
  for (const match of text.matchAll(/-?\d+(?:['.,]\d+)*/g)) {
    if (!numbersIn(match[0]).some((n) => Math.abs(n - value) < AMOUNT_TOLERANCE)) continue;
    if (HEDGE_BEFORE.test(text.slice(Math.max(0, match.index - 30), match.index))) return true;
  }
  return false;
}

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

/**
 * Splits a quote into the source passages it is made of. Consecutive lines of
 * the quote that also stand together in the source form one passage; lines that
 * are in the source but not next to each other (a table header above row 3) are
 * separate passages. Returns null if any line is not in the source at all.
 */
export function passagesOf(evidence: string, normalisedSource: string): string[] | null {
  // A list bullet the model put in front of a quote ("- Cost center CC-2002.") is
  // cosmetic, like whitespace. ("-900" stays: a minus sign has no space after it.)
  const lines = evidence.split("\n").map((l) => normaliseForMatch(l).replace(/^[-*•]\s+/, "")).filter((l) => l !== "");
  const [first, ...rest] = lines; // array destructuring: first element, then the remainder
  if (first === undefined || !normalisedSource.includes(first)) return null;

  const passages: string[] = [];
  let current = first;
  for (const line of rest) {
    if (!normalisedSource.includes(line)) return null;
    const joined = `${current} ${line}`; // the source is normalised, so a newline is one space
    if (normalisedSource.includes(joined)) {
      current = joined;
    } else {
      passages.push(current);
      current = line;
    }
  }
  passages.push(current);
  return passages;
}

/** Checks every extracted value against the exact source text the model saw. */
export function findUnverifiedValues(x: Extraction, sourceText: string): UnverifiedValue[] {
  const source = normaliseForMatch(sourceText);
  const problems: UnverifiedValue[] = [];

  // One evidence quote supporting one or more values. `valueTests` say, per
  // field name, whether a value can be read from a given passage. All of them
  // must pass in the SAME passage, so values can't be stitched together from
  // different places in the document.
  type ValueTests = Record<string, (passage: string) => boolean>;
  function check(field: string, evidence: string | null, hasValue: boolean, valueTests: ValueTests) {
    if (!hasValue) return; // nothing claimed, nothing to verify
    if (evidence === null || evidence.trim() === "") {
      problems.push({ field, reason: "missing_evidence" });
      return;
    }
    const passages = passagesOf(evidence, source);
    if (passages === null) {
      problems.push({ field, reason: "quote_not_in_source" });
      return;
    }
    const tests = Object.entries(valueTests);
    // Report against the passage that supports the most values.
    const failuresPerPassage = passages.map((p) => tests.filter(([, test]) => !test(p)).map(([name]) => name));
    const fewest = failuresPerPassage.reduce((a, b) => (b.length < a.length ? b : a));
    for (const name of fewest) problems.push({ field: name, reason: "value_not_in_quote" });
  }

  // Simple text fields: the value must appear in its own quote.
  const textFields = [
    "requester_name", "requester_email", "supplier_name", "supplier_vat_id",
    "cost_center_code", "cost_center_name", "quote_number",
  ] as const; // `as const` makes this a tuple of exact string literals, so x[f] is typed
  for (const f of textFields) {
    const { value, evidence } = x[f];
    if (value !== null) check(f, evidence, true, { [f]: (p) => textInQuote(value, p) });
  }

  {
    const { value, evidence } = x.currency;
    if (value !== null) check("currency", evidence, true, { currency: (p) => currencyInQuote(value, p) });
  }

  for (const f of ["net_total", "vat_amount", "gross_total", "total_unlabelled"] as const) {
    const { value, evidence } = x[f];
    if (value !== null) check(f, evidence, true, { [f]: (p) => numberInQuote(value, p) });
  }

  for (const f of ["requested_delivery", "quote_valid_until"] as const) {
    const { text, iso, evidence } = x[f];
    check(f, evidence, text !== null || iso !== null, {
      [`${f}.text`]: (p) => text === null || textInQuote(text, p),
      [`${f}.iso`]: (p) => iso === null || dateInQuote(iso, p),
    });
  }

  x.line_items.forEach((item, i) => {
    const f = `line_items[${i}]`;
    const num = (v: number | null) => (p: string) => v === null || numberInQuote(v, p);
    const txt = (v: string | null) => (p: string) => v === null || textInQuote(v, p);
    check(f, item.evidence, true, {
      [`${f}.description`]: txt(item.description),
      [`${f}.item_code`]: txt(item.item_code),
      [`${f}.unit`]: txt(item.unit),
      [`${f}.quantity`]: num(item.quantity),
      [`${f}.unit_price`]: num(item.unit_price),
      [`${f}.price_per`]: item.price_per === 1 ? () => true : num(item.price_per),
      [`${f}.line_total`]: num(item.line_total),
    });
  });

  x.referenced_requests.forEach((r, i) => {
    const f = `referenced_requests[${i}]`;
    check(f, r.evidence, true, { [f]: (p) => textInQuote(r.value, p) });
  });

  // Notes are the model's own summary, so only their quote is checked.
  x.notes_for_clerk.forEach((n, i) => check(`notes_for_clerk[${i}]`, n.evidence, n.evidence !== null, {}));

  return problems;
}
