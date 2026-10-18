import { issue, type Issue } from "./issues.ts";
import { round2 } from "./money.ts";

// Brief §4.5: approval limits are in CHF. Convert with the fixed table from the
// database (production: daily ECB rates). The original currency and amount are
// kept: the order is placed in the supplier's currency.

export interface FxResult {
  rate: number | null;
  netChf: number | null;
  issues: Issue[];
}

export function convertToChf(
  net: number | null,
  currency: string | null,
  currencyUnverified: boolean,
  ratesToChf: Map<string, number>,
): FxResult {
  if (currency === null) {
    return {
      rate: null,
      netChf: null,
      issues: currencyUnverified ? [] : [issue("CURRENCY_MISSING", "blocks_approval", "currency", "The email does not state a currency.")],
    };
  }
  const rate = ratesToChf.get(currency);
  if (rate === undefined) {
    return {
      rate: null,
      netChf: null,
      issues: [issue("CURRENCY_UNSUPPORTED", "blocks_approval", "currency",
        `No exchange rate for ${currency}; supported: ${[...ratesToChf.keys()].join(", ")}.`)],
    };
  }
  return { rate, netChf: net === null ? null : round2(net * rate), issues: [] };
}
