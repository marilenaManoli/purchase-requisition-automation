import type { CostCenterRow } from "../db/queries.ts";
import { issue, type Issue } from "./issues.ts";

// Brief §6: use the code stated in the email. A code that is not in the master
// data is not a match: no closest-match fallback. Without a valid cost centre
// there is no chain, so the requisition goes to the clerk. Hints (a cost-centre
// name like "London office", the requester's default cost centre) are offered
// as suggestions only, never applied (assumption 6).

export interface CostCenterCheck {
  code: string | null;
  suggestions: string[]; // cost-centre codes the clerk might pick
  issues: Issue[];
}

// Letters, an optional hyphen, digits: CC-1002, CC 9100, KST4711. ("CC-9100" looks
// right but isn't in the master data: that stays COST_CENTER_UNKNOWN.)
const LOOKS_LIKE_A_CODE = /^[A-Z]{1,5}[- ]?\d{2,6}$/i;

export function checkCostCenter(
  statedCode: string | null,
  statedName: string | null,
  codeUnverified: boolean,
  requesterDefault: string | null,
  costCenters: CostCenterRow[],
): CostCenterCheck {
  // A "code" that doesn't even look like one ("London office") is a name: the model
  // put it in the wrong field. Treat it as a hint, so the clerk gets a suggestion.
  if (statedCode !== null && !LOOKS_LIKE_A_CODE.test(statedCode.trim())) {
    statedName = statedName ?? statedCode;
    statedCode = null;
  }

  if (statedCode !== null) {
    // Only formatting is normalised ("cc-1002 " → "CC-1002"), never the digits.
    const code = statedCode.trim().toUpperCase();
    if (costCenters.some((c) => c.code === code)) {
      return { code, suggestions: [], issues: [] };
    }
    return {
      code: null,
      suggestions: [],
      issues: [issue("COST_CENTER_UNKNOWN", "blocks_approval", "cost_center_code",
        `Cost centre ${code} does not exist in the master data. It is not replaced by a similar-looking code.`)],
    };
  }

  const suggestions = [
    ...(statedName === null ? [] : costCentersMatchingName(statedName, costCenters)),
    ...(requesterDefault === null ? [] : [requesterDefault]),
  ];
  const unique = [...new Set(suggestions)]; // a Set drops duplicates; spread turns it back into an array

  if (codeUnverified) return { code: null, suggestions: unique, issues: [] }; // already reported as unverified
  const hint = unique.length > 0 ? ` Suggestions for the clerk: ${unique.join(", ")}.` : "";
  return {
    code: null,
    suggestions: unique,
    issues: [issue("COST_CENTER_MISSING", "blocks_approval", "cost_center_code",
      `No cost centre code in the email, so no approval chain can be built.${hint}`)],
  };
}

/** "London office" → CC-3002 "Office London": every word of the hint appears in the name. */
function costCentersMatchingName(hint: string, costCenters: CostCenterRow[]): string[] {
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9äöü]+/).filter((w) => w.length > 0);
  const hintWords = words(hint);
  if (hintWords.length === 0) return [];
  return costCenters
    .filter((c) => {
      const nameWords = new Set(words(c.name));
      return hintWords.every((w) => nameWords.has(w));
    })
    .map((c) => c.code);
}
