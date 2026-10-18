// Brief §7: the states a requisition moves through, and the only allowed moves.
//
//   inbox ─▶ extracted ─▶ pending_approval ─▶ approved ─▶ ordered
//     │          │              │   ▲
//     └──────────┴─▶ needs_review ──┘
//                       │   ▲   │
//                       ▼   │   ▼
//                     rejected ◀┘ (from pending_approval too)

// `as const` keeps the exact strings, so State is a union of these seven literals.
export const STATES = ["inbox", "extracted", "needs_review", "pending_approval", "approved", "ordered", "rejected"] as const;
export type State = (typeof STATES)[number];

export const ALLOWED_TRANSITIONS: Record<State, readonly State[]> = {
  inbox: ["extracted", "needs_review"], // needs_review directly when extraction fails
  extracted: ["pending_approval", "needs_review"], // a clean requisition skips review
  needs_review: ["pending_approval", "rejected"],
  pending_approval: ["approved", "rejected", "needs_review"], // back to review if a clerk must fix something
  approved: ["ordered"],
  ordered: [], // final
  rejected: ["needs_review"], // a corrected rejection comes back and restarts the chain (6b)
};

export function canTransition(from: State, to: State): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
