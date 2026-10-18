import { ALLOWED_TRANSITIONS, STATES, type State } from "../workflow/states.ts";

// The workflow diagram (brief D2), drawn as SVG from ALLOWED_TRANSITIONS: the
// same table transition() enforces, so the picture can't drift from the code.
// Only the box positions are chosen by hand.

const BOX_W = 150;
const BOX_H = 44;

// Happy path along the top; review and rejection below.
const POSITION: Record<State, { x: number; y: number }> = {
  inbox: { x: 10, y: 20 },
  extracted: { x: 200, y: 20 },
  pending_approval: { x: 410, y: 20 },
  approved: { x: 620, y: 20 },
  ordered: { x: 810, y: 20 },
  needs_review: { x: 300, y: 150 },
  rejected: { x: 540, y: 150 },
};

const LABEL: Record<State, string> = {
  inbox: "Inbox",
  extracted: "Extracted",
  needs_review: "Needs review",
  pending_approval: "Pending approval",
  approved: "Approved",
  ordered: "Ordered",
  rejected: "Rejected",
};

export interface DiagramOptions {
  current?: State; // highlighted
  visited?: Set<State>; // states this requisition has been in
  counts?: Partial<Record<State, number>>; // shown in each box
}

/** Where the line from `from` towards `to` leaves the box around `from`'s centre. */
function edgePoint(fromCenter: { x: number; y: number }, toCenter: { x: number; y: number }) {
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const scale = 1 / Math.max(Math.abs(dx) / (BOX_W / 2), Math.abs(dy) / (BOX_H / 2));
  return { x: fromCenter.x + dx * scale, y: fromCenter.y + dy * scale };
}

const center = (s: State) => ({ x: POSITION[s].x + BOX_W / 2, y: POSITION[s].y + BOX_H / 2 });

export function workflowSvg(options: DiagramOptions = {}): string {
  const arrows: string[] = [];
  for (const from of STATES) {
    for (const to of ALLOWED_TRANSITIONS[from]) {
      // Two-way pairs (e.g. needs_review ⇄ pending_approval) are drawn as two
      // parallel lines, shifted sideways so they don't overlap.
      const twoWay = ALLOWED_TRANSITIONS[to].includes(from);
      const a = center(from);
      const b = center(to);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const shift = twoWay ? 6 : 0;
      const nx = (-(b.y - a.y) / len) * shift; // normal vector, scaled
      const ny = ((b.x - a.x) / len) * shift;
      const start = edgePoint({ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny });
      const end = edgePoint({ x: b.x + nx, y: b.y + ny }, { x: a.x + nx, y: a.y + ny });
      arrows.push(
        `<line data-from="${from}" data-to="${to}" x1="${start.x.toFixed(1)}" y1="${start.y.toFixed(1)}" ` +
          `x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}" class="wf-edge" marker-end="url(#wf-arrow)"/>`,
      );
    }
  }

  const boxes = STATES.map((s) => {
    const { x, y } = POSITION[s];
    const cls = ["wf-box", s === options.current ? "wf-current" : "", options.visited?.has(s) ? "wf-visited" : ""].filter(Boolean).join(" ");
    const count = options.counts?.[s];
    return (
      `<g data-state="${s}" class="${cls}">` +
      `<rect x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="8"/>` +
      `<text x="${x + BOX_W / 2}" y="${y + (count === undefined ? 27 : 20)}">${LABEL[s]}</text>` +
      (count === undefined ? "" : `<text x="${x + BOX_W / 2}" y="${y + 36}" class="wf-count">${count}</text>`) +
      `</g>`
    );
  });

  return `<svg class="wf" viewBox="0 0 970 210" role="img" aria-label="Requisition workflow">
  <defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" class="wf-arrowhead"/></marker></defs>
  ${arrows.join("\n  ")}
  ${boxes.join("\n  ")}
</svg>`;
}
