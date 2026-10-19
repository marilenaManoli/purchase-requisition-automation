// Brief §6: a GL account is optional. "Suggesting one from the item description and
// letting the clerk confirm it earns extra credit; guessing one and presenting it as
// confirmed does not." So this only ever produces a SUGGESTION with its reason; the
// confirmed account is set by the clerk (workflow/ordering.ts: confirmGlAccount).
//
// Plain rules, not another LLM call: every suggestion can be explained in one sentence.

export interface GlSuggestion {
  code: string;
  reason: string;
}

// Keywords (German and English) per GL account, matched at the start of a word.
const KEYWORDS: [code: string, words: string[]][] = [
  ["5300", ["bearing", "lager", "wälzlager", "waelzlager", "kugellager", "spare", "ersatzteil", "dichtung", "o-ring", "seal"]],
  ["5200", ["screw", "schraube", "washer", "unterlegscheibe", "fastener", "clip", "kabelbinder", "isopropanol", "flux", "adhesive", "kleber", "cable", "kabel"]],
  ["5400", ["fixture", "vorrichtung", "spann", "clamp", "werkzeug", "tool", "wendeschneidplatte", "messerkopf", "bohrer", "drill"]],
  ["5100", ["repair", "reparatur", "wartung", "maintenance", "grease", "schmier", "kühler", "kuehler", "ruecklaufkuehler"]],
  ["6200", ["prototype", "prototyp", "print run", "3d print", "sls"]],
  ["7100", ["chair", "stuhl", "drehstuhl", "desk", "schreibtisch", "lamp", "lampe", "rollcontainer", "paper", "papier"]],
  ["7200", ["monitor", "laptop", "notebook", "docking", "keyboard", "tastatur", "server"]],
  ["7300", ["licence", "license", "lizenz", "software", "subscription"]],
  ["7400", ["calibration", "kalibrier", "messuhr", "messschraube", "messmittel", "messgerät", "multimeter", "load cell", "endmass", "gauge"]],
  ["7500", ["karton", "carton", "packaging", "verpackung", "polster", "stretch film", "folie", "wrap"]],
  ["7600", ["freight", "fracht", "transport", "shipping", "versand", "logistics"]],
];
const FREIGHT = "7600";

// Cost centres whose purchases almost always book to one account (a fallback only).
const COST_CENTER_DEFAULT: Record<string, string> = {
  "CC-5001": "7200", // IT Infrastructure
  "CC-5002": "7300", // IT Software & Licences
  "CC-3001": "7100", // Office Zurich HQ
  "CC-3002": "7100", // Office London
  "CC-3003": "7100", // Office Schorndorf
  "CC-2001": "6100", // R&D Hardware
  "CC-2003": "6200", // Product Design
};

/**
 * The account for one item description, or null. A keyword matches at the END of a
 * word first: German compounds put the main noun last ("Rillenkugellager" is a bearing,
 * "Spannlager" too, not a clamp). Then at the start of a word ("Spannvorrichtung").
 */
export function accountForDescription(description: string): { code: string; word: string } | null {
  const words = description.toLowerCase().split(/[^a-zäöüß0-9-]+/).filter((w) => w.length > 0);
  const text = ` ${words.join(" ")} `;
  for (const position of ["end", "start"] as const) {
    for (const [code, keywords] of KEYWORDS) {
      const hit = keywords.find((k) =>
        k.includes(" ") ? text.includes(` ${k}`) // multi-word keywords like "load cell"
          : words.some((w) => (position === "end" ? w.endsWith(k) : w.startsWith(k))));
      if (hit) return { code, word: hit };
    }
  }
  return null;
}

export function suggestGlAccount(
  costCenterCode: string | null,
  lineDescriptions: string[],
  glAccounts: { code: string; name: string }[],
): GlSuggestion | null {
  const name = (code: string) => glAccounts.find((g) => g.code === code)?.name ?? code;

  // 1. Item descriptions. Freight lines only count if there's nothing else. A suggestion
  //    needs real support: at least half of the goods lines match, and one account holds
  //    at least 60 % of the matches (one "load cell" among four lines isn't enough).
  const all = lineDescriptions.map((d) => ({ d, m: accountForDescription(d) }));
  const isFreight = (x: (typeof all)[number]) => x.m?.code === FREIGHT;
  const goodsLines = all.filter((x) => !isFreight(x));
  const pool = goodsLines.length > 0 ? goodsLines : all;
  const matched = pool.filter((x): x is { d: string; m: { code: string; word: string } } => x.m !== null); // a type guard in a filter
  const counts = new Map<string, number>();
  for (const x of matched) counts.set(x.m.code, (counts.get(x.m.code) ?? 0) + 1);
  const [best, votes] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (best !== null && matched.length * 2 >= pool.length && votes / matched.length >= 0.6) {
    const example = matched.find((x) => x.m.code === best)!; // exists: best came from these matches
    const support = votes === pool.length ? "" : ` (${votes} of ${pool.length} items)`;
    return { code: best, reason: `item "${example.d}" contains "${example.m.word}"${support} → ${best} ${name(best)}` };
  }

  // 2. Lines disagree or nothing matched: a cost-centre default, if there is one.
  const byCostCenter = costCenterCode ? COST_CENTER_DEFAULT[costCenterCode] : undefined;
  if (byCostCenter) {
    return { code: byCostCenter, reason: `cost centre ${costCenterCode} usually books to ${byCostCenter} ${name(byCostCenter)}` };
  }

  // 3. No confident suggestion: better none than a weak guess.
  return null;
}
