import type { SupplierRow } from "../db/queries.ts";
import { issue, type Issue } from "./issues.ts";

// Brief §6: match on VAT ID first (unambiguous), fall back to the name and
// treat a name-only match as less certain. Unknown, blocked, ambiguous or
// conflicting suppliers stop automatic progression. Never create a supplier.

export interface SupplierMatch {
  supplierId: string | null;
  matchedBy: "vat" | "name" | null;
  issues: Issue[];
}

/** "CHE-101.234.567 MWST" and "che101234567" compare equal; so do "DE 123 456 789" and "DE123456789". */
export function normaliseVatId(vat: string): string {
  return vat
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "") // spaces, dots, hyphens
    .replace(/(MWST|TVA|IVA|VAT)$/, ""); // Swiss suffixes for the same number
}

// Legal-form words removed from the END of a name: "Acme Bearings GmbH" → "acme bearings".
const LEGAL_FORMS = new Set(["gmbh", "ag", "kg", "co", "ltd", "limited", "inc", "llc", "plc", "bv", "as", "ou", "srl", "sa", "se"]);

/** Lower-case words with umlauts written out: "Müller Industriebedarf AG" → ["mueller", "industriebedarf", "ag"]. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    // Estonian "OÜ" is a legal form, not an umlaut to expand. (A lookahead, not \b:
    // in JS regex \b only knows ASCII letters, so "oü\b" never matches.)
    .replace(/\boü(?=\s|$)/g, "ou")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ");
}

/** Comparable form of a company name: case, umlauts (ü ↔ ue), punctuation and legal form ignored. */
export function normaliseCompanyName(name: string): string {
  const tokens = words(name);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens.at(-1) ?? "")) tokens.pop();
  return tokens.join(" ");
}

/**
 * Suppliers whose name matches. An exact (case-insensitive) match wins over a
 * normalised one: "Mueller Industriebedarf AG" is exactly SUP-007, even though
 * normalised it would also equal "Müller Industriebedarf" (SUP-004).
 */
function suppliersByName(name: string, suppliers: SupplierRow[]): SupplierRow[] {
  const exact = suppliers.filter((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  if (exact.length > 0) return exact;
  const key = normaliseCompanyName(name);
  return suppliers.filter((s) => normaliseCompanyName(s.name) === key);
}

/**
 * @param name, vatId  trusted extracted values (null = not stated or not verified)
 * @param anyUnverified true if name or VAT was extracted but failed verification,
 *                      so "missing" isn't reported twice for the same cause
 */
export function matchSupplier(
  name: string | null,
  vatId: string | null,
  anyUnverified: boolean,
  suppliers: SupplierRow[],
): SupplierMatch {
  const byVat = vatId === null ? undefined : suppliers.find((s) => s.vat_id !== null && normaliseVatId(s.vat_id) === normaliseVatId(vatId));
  const byName = name === null ? [] : suppliersByName(name, suppliers);

  // Each branch returns early: the first rule that applies decides.
  if (vatId !== null && byVat === undefined) {
    const hint = byName.length === 1 ? ` The name matches ${byName[0]?.id} ${byName[0]?.name}, but its VAT ID differs.` : "";
    return none(issue("SUPPLIER_VAT_UNKNOWN", "blocks_approval", "supplier_vat_id",
      `VAT ID ${vatId} is not in the supplier master data.${hint} The clerk may create the supplier or correct the match.`));
  }

  if (byVat !== undefined) {
    // A name that points at a DIFFERENT supplier is a conflict (email 11).
    // A name that matches nothing at all is just a different spelling: VAT ID wins.
    if (byName.length > 0 && !byName.some((s) => s.id === byVat.id)) {
      return none(issue("SUPPLIER_CONFLICT", "blocks_approval", "supplier_name",
        `Name "${name}" matches ${byName.map((s) => s.id).join(", ")}, but VAT ID ${vatId} belongs to ${byVat.id} ${byVat.name}. The clerk decides.`));
    }
    return withStatusCheck(byVat, "vat", []);
  }

  // No VAT ID: fall back to the name.
  if (name === null) {
    return anyUnverified ? none() : none(issue("SUPPLIER_MISSING", "blocks_approval", "supplier_name", "No supplier is stated in the email."));
  }
  if (byName.length === 0) {
    return none(issue("SUPPLIER_UNKNOWN", "blocks_approval", "supplier_name",
      `Supplier "${name}" is not in the master data. The clerk may create it; it is never created automatically.`));
  }
  if (byName.length > 1) {
    return none(issue("SUPPLIER_AMBIGUOUS", "blocks_approval", "supplier_name",
      `Name "${name}" matches several suppliers (${byName.map((s) => s.id).join(", ")}) and no VAT ID is given.`));
  }
  const [only] = byName as [SupplierRow]; // length checked above, so this tuple type is safe
  return withStatusCheck(only, "name", [
    issue("SUPPLIER_NAME_ONLY", "warning", "supplier_name",
      `Matched to ${only.id} ${only.name} by name only (no VAT ID in the email): less certain, please confirm.`),
  ]);
}

function withStatusCheck(s: SupplierRow, matchedBy: "vat" | "name", issues: Issue[]): SupplierMatch {
  if (s.status === "blocked") {
    issues.push(issue("SUPPLIER_BLOCKED", "blocks_approval", "supplier_name",
      `${s.id} ${s.name} is blocked in the master data. Nothing may be ordered from a blocked supplier.`));
  }
  return { supplierId: s.id, matchedBy, issues };
}

// Rest parameter: none() or none(issueA) both work.
/**
 * Step 9 fallback, used only when the model gave no usable supplier: code looks for
 * master-data supplier names in the email itself. Exactly one found → a name-only
 * match with a warning. Several found, or the model claimed a different supplier →
 * nothing (the clerk decides). A match against master data by code, never a guess.
 */
export function matchSupplierInText(text: string, modelClaim: string | null, suppliers: SupplierRow[]): SupplierMatch | null {
  const haystack = ` ${words(text).join(" ")} `;
  const found = suppliers.filter((s) => haystack.includes(` ${normaliseCompanyName(s.name)} `));
  if (found.length !== 1) return null;
  const [only] = found as [SupplierRow];
  if (modelClaim !== null) {
    // The model named a supplier (even if unverified): the one found in the text must be
    // that same company ("Sensorik Nord" ⊂ "sensorik nord gmbh"), not a different one,
    // known or unknown. Otherwise it's a conflict for the clerk.
    const claim = normaliseCompanyName(modelClaim);
    const found = normaliseCompanyName(only.name);
    if (!(claim === found || found.includes(claim) || claim.includes(found))) return null;
  }
  return withStatusCheck(only, "name", [
    issue("SUPPLIER_FOUND_IN_TEXT", "warning", "supplier_name",
      `The model gave no verifiable supplier; ${only.id} ${only.name} was found by name in the email text. Less certain: please confirm.`),
  ]);
}

function none(...issues: Issue[]): SupplierMatch {
  return { supplierId: null, matchedBy: null, issues };
}
