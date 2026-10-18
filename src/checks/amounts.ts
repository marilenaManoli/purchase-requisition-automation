import { issue, type Issue } from "./issues.ts";
import { round2, sameAmount } from "./money.ts";

// Brief §4.6 and §5: the NET amount decides the band and is the PO total; VAT
// is recorded. A requisition must never route on a figure the document itself
// contradicts, so every stated figure is cross-checked, and on any conflict the
// net amount stays unestablished (null) and approval is blocked.

export interface LineInput {
  quantity: number | null;
  unitPrice: number | null;
  pricePer: number | null; // null = per single unit
  lineTotal: number | null; // as stated in the document
  untrusted: boolean; // some value of this line failed the evidence check
}

export interface StatedTotal {
  value: number;
  evidence: string; // used to read the label, e.g. "Zwischensumme: 9,700.00 CHF"
}

export interface AmountsInput {
  lines: LineInput[];
  totals: StatedTotal[]; // every total the model reported, whatever field it chose
  vatAmount: number | null;
}

export interface AmountsResult {
  lineAmounts: (number | null)[]; // per line: qty × price / price_per
  net: number | null; // null = not established
  vat: number | null;
  gross: number | null;
  issues: Issue[];
}

// The label is read from the evidence by code, not taken from the model's
// choice of field (in 3b the model put "CHF 999.00 in total" into net_total).
// Net is tested first, so "Total excl. VAT" counts as net, not gross.
const NET_LABEL = /\b(net|netto|subtotal|sub-total|zwischensumme|excl|exkl|excluding|exklusive|zzgl|ohne mwst)\b/i;
const GROSS_LABEL = /\b(gross|brutto|incl|inkl|including|inklusive)\b/i;

export function classifyTotal(evidence: string): "net" | "gross" | "unlabelled" {
  if (NET_LABEL.test(evidence)) return "net";
  if (GROSS_LABEL.test(evidence)) return "gross";
  return "unlabelled";
}

/** qty × unit price ÷ price_per, checked against the stated line total. */
export function lineAmount(line: LineInput, position: number): { amount: number | null; issues: Issue[] } {
  const field = `line_items[${position - 1}]`;
  if (line.untrusted) return { amount: null, issues: [] }; // already reported as unverified

  const issues: Issue[] = [];
  if (line.unitPrice === null) {
    // Assumption 3: a free-of-charge line is not silently priced at 0; the clerk confirms.
    issues.push(issue("LINE_PRICE_MISSING", "blocks_approval", `${field}.unit_price`,
      `Line ${position} has no price, so the requisition cannot be totalled. If it is free of charge, the clerk can confirm a price of 0.`));
  }
  if (line.quantity === null) {
    issues.push(issue("LINE_QUANTITY_MISSING", "blocks_approval", `${field}.quantity`,
      `Line ${position} has no exact quantity.`));
  }
  if (line.unitPrice === null || line.quantity === null) return { amount: null, issues };

  const computed = round2((line.quantity * line.unitPrice) / (line.pricePer ?? 1));
  if (line.lineTotal !== null && !sameAmount(computed, line.lineTotal)) {
    issues.push(issue("LINE_TOTAL_MISMATCH", "blocks_approval", `${field}.line_total`,
      `Line ${position}: ${line.quantity} × ${line.unitPrice}${line.pricePer ? ` per ${line.pricePer}` : ""} = ${computed}, but the document says ${line.lineTotal}.`));
    return { amount: null, issues };
  }
  return { amount: computed, issues };
}

export function checkAmounts(input: AmountsInput): AmountsResult {
  const issues: Issue[] = [];
  const contradiction = (message: string) => issues.push(issue("AMOUNT_CONTRADICTION", "blocks_approval", null, message));

  // 1. Lines.
  const lineResults = input.lines.map((l, i) => lineAmount(l, i + 1));
  lineResults.forEach((r) => issues.push(...r.issues));
  const lineAmounts = lineResults.map((r) => r.amount);
  if (input.lines.length === 0) {
    issues.push(issue("NO_LINE_ITEMS", "blocks_approval", "line_items", "The email lists no items to order."));
  }
  const allLinesPriced = input.lines.length > 0 && lineAmounts.every((a) => a !== null);
  // `as number[]` is safe: allLinesPriced guarantees there is no null in the array.
  const linesSum = allLinesPriced ? round2((lineAmounts as number[]).reduce((a, b) => a + b, 0)) : null;

  // 2. Sort the stated totals by their label, dropping repeats of the same figure.
  const byLabel = { net: [] as number[], gross: [] as number[], unlabelled: [] as number[] };
  for (const t of input.totals) {
    const bucket = byLabel[classifyTotal(t.evidence)];
    if (!bucket.some((v) => sameAmount(v, t.value))) bucket.push(t.value);
  }
  const vat = input.vatAmount;

  // 3. Net: a labelled net total and the sum of the lines must agree.
  if (byLabel.net.length > 1) contradiction(`The document states different net totals: ${byLabel.net.join(" vs ")}.`);
  const net: number | null = byLabel.net[0] ?? linesSum;
  if (byLabel.net[0] !== undefined && linesSum !== null && !sameAmount(byLabel.net[0], linesSum)) {
    contradiction(`The lines add up to ${linesSum}, but the document states a net total of ${byLabel.net[0]}.`);
  }

  // 4. A total without a VAT label must match net, net + VAT, or a labelled gross
  //    (email 24: "Total: 4,830" next to lines and a subtotal of 4,380 → contradiction).
  if (net !== null) {
    for (const u of byLabel.unlabelled) {
      const fits = sameAmount(u, net) || (vat !== null && sameAmount(u, net + vat)) || byLabel.gross.some((g) => sameAmount(g, u));
      if (!fits) contradiction(`The document's total ${u} matches neither the net amount ${net}${vat !== null ? ` nor net + VAT ${round2(net + vat)}` : ""}.`);
    }
  }

  // 5. Gross: must equal net + VAT when both are stated, and can never be below net.
  for (const g of byLabel.gross) {
    if (net !== null && vat !== null && !sameAmount(g, net + vat)) {
      contradiction(`Net ${net} + VAT ${vat} = ${round2(net + vat)}, but the document states a gross total of ${g}.`);
    } else if (net !== null && g < net - 0.01) {
      contradiction(`The gross total ${g} is lower than the net amount ${net}.`);
    }
  }
  const gross = byLabel.gross[0] ?? null;

  // 6. Is there a net amount at all, and is it plausible?
  if (net === null && !issues.some((i) => i.severity === "blocks_approval")) {
    issues.push(issue("AMOUNT_MISSING", "blocks_approval", null, "No amount could be established from the email."));
  }
  if (net !== null && net <= 0) {
    issues.push(issue("AMOUNT_NOT_POSITIVE", "blocks_approval", null, `The net amount ${net} is not positive.`));
  }
  if (net !== null && byLabel.net.length === 0 && byLabel.gross.length === 0 && vat === null) {
    issues.push(issue("VAT_STATUS_NOT_STATED", "warning", null,
      `The email doesn't say whether ${net} includes VAT; it is treated as net (assumption 7).`));
  }

  // Never route on a contradicted or incomplete figure. An untrusted line counts
  // as incomplete: a stated net can't be cross-checked against lines we can't total.
  const blocked = issues.some((i) => i.severity === "blocks_approval");
  const incomplete = input.lines.some((l) => l.untrusted);
  return { lineAmounts, net: blocked || incomplete ? null : net, vat, gross, issues };
}
