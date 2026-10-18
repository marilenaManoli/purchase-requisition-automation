import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/db.ts";
import type { ReferenceData } from "../db/queries.ts";
import type { ErpClient } from "../erp/poClient.ts";
import type { LlmClient } from "../extract/llm.ts";
import { ApprovalError, approve, reject } from "../workflow/approvals.ts";
import { reopenRejected, resolveIssue, submitForApproval } from "../workflow/clerk.ts";
import { editRequisition, pullBackForCorrection } from "../workflow/edits.ts";
import { sendToErp, setDeliveryDate } from "../workflow/ordering.ts";
import { extractAndRoute, ingestEmail } from "../workflow/processEmail.ts";
import { STATES } from "../workflow/states.ts";
import { InvalidTransitionError } from "../workflow/transitions.ts";
import { parseAssignments, parseEditForm } from "./forms.ts";
import { employeeName, formatMoney, inboxRows, requisitionDetail } from "./views.ts";
import { workflowSvg } from "./workflowDiagram.ts";
import type { State } from "../workflow/states.ts";

// The web app. `createApp` takes its dependencies as arguments, so tests can
// run it against an in-memory database and a fake LLM.
//
// Routes stay thin: parse the form, call one workflow function, redirect.
// The rules (who may approve, what may be edited when) live in those
// functions; hiding a button in a template is only a convenience.

export interface AppDeps {
  db: Db;
  ref: ReferenceData;
  llm: LlmClient;
  erp: ErpClient;
}

const ACT_AS_COOKIE = "actAs";
const MAX_EML_BYTES = 10 * 1024 * 1024;

export function createApp(deps: AppDeps): express.Express & { extractionsRunning: Set<number> } {
  const { db, ref, llm, erp } = deps;
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", fileURLToPath(new URL("./views", import.meta.url)));
  app.use(express.urlencoded({ extended: false })); // HTML form posts


  // Extractions running in the background (one at a time per requisition).
  const running = new Set<number>();
  function startExtraction(id: number): boolean {
    if (running.has(id)) return false;
    running.add(id);
    extractAndRoute(db, id, llm, ref)
      .catch((err: Error) => console.error(`[pipeline] requisition ${id}: ${err.name}`)) // ids only, no content
      .finally(() => running.delete(id));
    return true;
  }

  // "Act as": who is using the app (assumption 5: stands in for a real login).
  app.use((req, res, next) => {
    const chosen = readCookie(req, ACT_AS_COOKIE);
    const actor = chosen && (chosen === "clerk" || ref.employees.some((e) => e.id === chosen)) ? chosen : "clerk";
    res.locals.actor = actor;
    res.locals.actorName = actor === "clerk" ? "Clerk" : employeeName(ref, actor);
    res.locals.people = ref.employees.filter((e) => e.role !== "requester_only");
    res.locals.formatMoney = formatMoney;
    next();
  });

  // (Runs after the act-as middleware: the error page shows the current user.)
  // Every state-changing request must come from this app's own pages. Browsers
  // send an Origin (or at least a Referer) header with a POST; a form on another
  // website would carry that site's origin and is refused. Without this, a
  // forged POST without our cookie would run as the default actor, the clerk.
  // (Production: CSRF tokens or SSO sessions.) Requests with neither header
  // (curl, tests) are allowed: they can't ride on a victim's browser.
  app.use((req, res, next) => {
    if (req.method !== "POST") return next();
    const source = req.get("origin") ?? req.get("referer");
    if (source === undefined || sameHost(source, req.get("host"))) return next();
    res.status(403).render("error", { message: "Request refused: it did not come from this application." });
  });

  const clerkOnly = (_req: Request, res: Response, next: NextFunction) => {
    if (res.locals.actor === "clerk") return next();
    res.status(403).render("error", { message: "Only the clerk can do this. Switch to Clerk at the top right." });
  };

  /** Runs a workflow action; a business-rule refusal is shown on the page instead of failing. */
  async function act(req: Request, res: Response, action: (id: number, actor: string) => unknown | Promise<unknown>, done: string) {
    const id = Number(req.params.id);
    try {
      await action(id, res.locals.actor as string);
      res.redirect(`/requisitions/${id}?${new URLSearchParams({ msg: done })}`);
    } catch (err) {
      if (err instanceof ApprovalError || err instanceof InvalidTransitionError) {
        res.redirect(`/requisitions/${id}?${new URLSearchParams({ error: err.message })}`);
      } else {
        throw err; // a real bug: goes to the error handler
      }
    }
  }
  const field = (req: Request, name: string) => String(req.body[name] ?? "");

  app.post("/act-as", (req, res) => {
    res.cookie(ACT_AS_COOKIE, String(req.body.actor ?? "clerk"), { httpOnly: true, sameSite: "lax" });
    res.redirect(safeBack(req));
  });

  // --- Pages ---------------------------------------------------------------

  app.get("/", (req, res) => {
    const state = typeof req.query.state === "string" && (STATES as readonly string[]).includes(req.query.state) ? req.query.state : undefined;
    const mine = req.query.mine === "1" && res.locals.actor !== "clerk";
    const rows = inboxRows(db, ref, { state, waitingFor: mine ? res.locals.actor : undefined });
    res.render("inbox", { rows, states: STATES, selectedState: state ?? "", mine, error: req.query.error ?? null });
  });

  app.get("/workflow", (_req, res) => {
    const rows = db.prepare(`SELECT state, COUNT(*) AS n FROM requisitions GROUP BY state`).all() as { state: State; n: number }[];
    const counts = Object.fromEntries(STATES.map((s) => [s, rows.find((r) => r.state === s)?.n ?? 0]));
    res.render("workflow", { svg: workflowSvg({ counts }) });
  });

  app.get("/requisitions/:id", (req, res, next) => {
    const detail = requisitionDetail(db, ref, Number(req.params.id));
    if (!detail) return next(); // falls through to the 404 handler
    const visited = new Set<State>(detail.audit.map((a) => a.to_state));
    res.render("detail", {
      r: detail,
      svg: workflowSvg({ current: detail.state, visited }),
      ref,
      extracting: running.has(detail.id),
      msg: typeof req.query.msg === "string" ? req.query.msg : null,
      error: typeof req.query.error === "string" ? req.query.error : null,
    });
  });

  // --- Clerk actions -------------------------------------------------------

  // Upload: the browser sends the file's bytes as message/rfc822 (see inbox.ejs).
  app.post("/upload", clerkOnly, express.raw({ type: "message/rfc822", limit: MAX_EML_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.redirect(`/?${new URLSearchParams({ error: "Choose an .eml file to upload." })}`);
    }
    const filename = decodeURIComponent(String(req.get("x-filename") ?? "")).slice(0, 200) || null;
    const id = await ingestEmail(db, req.body, filename); // stored immediately…
    startExtraction(id); // …extraction continues in the background
    res.redirect(`/requisitions/${id}`);
  });

  app.post("/requisitions/:id/retry", clerkOnly, (req, res) =>
    act(req, res, (id) => {
      if (!startExtraction(id)) throw new ApprovalError("Extraction is already running.");
    }, "Extraction restarted."));

  app.post("/requisitions/:id/edit", clerkOnly, (req, res) =>
    act(req, res, (id, actor) => editRequisition(db, id, actor, parseEditForm(req.body), ref), "Saved; all checks were run again."));

  app.post("/requisitions/:id/issues/:issueId/resolve", clerkOnly, (req, res) =>
    act(req, res, (id, actor) => {
      const issue = db.prepare(`SELECT requisition_id FROM issues WHERE id = ?`).get(Number(req.params.issueId)) as { requisition_id: number } | undefined;
      if (issue?.requisition_id !== id) throw new ApprovalError("That issue doesn't belong to this requisition.");
      resolveIssue(db, Number(req.params.issueId), actor, field(req, "note"));
    }, "Issue resolved."));

  app.post("/requisitions/:id/submit", clerkOnly, (req, res) =>
    act(req, res, (id, actor) => submitForApproval(db, id, actor, ref, parseAssignments(req.body)), "Sent for approval."));

  app.post("/requisitions/:id/pull-back", clerkOnly, (req, res) =>
    act(req, res, (id, actor) => pullBackForCorrection(db, id, actor, field(req, "reason")), "Pulled back for correction."));

  app.post("/requisitions/:id/reopen", clerkOnly, (req, res) =>
    act(req, res, (id, actor) => reopenRejected(db, id, actor, field(req, "note")), "Reopened for correction."));

  app.post("/requisitions/:id/delivery-date", clerkOnly, (req, res) =>
    act(req, res, (id, actor) => setDeliveryDate(db, id, actor, field(req, "date")), "Delivery date saved."));

  app.post("/requisitions/:id/order", clerkOnly, (req, res) =>
    act(req, res, async (id, actor) => {
      await sendToErp(db, id, actor, erp);
    }, "Booked in the ERP."));

  // --- Approver actions (the workflow functions check who may act) ---------

  app.post("/requisitions/:id/approve", (req, res) =>
    act(req, res, (id, actor) => approve(db, id, actor, field(req, "comment").trim() || null), "Approved."));

  app.post("/requisitions/:id/reject", (req, res) =>
    act(req, res, (id, actor) => reject(db, id, actor, field(req, "reason")), "Rejected."));

  // --- Fallbacks -----------------------------------------------------------

  app.use((_req, res) => {
    res.status(404).render("error", { message: "Not found." });
  });

  // Express 5 passes errors from async handlers here too. Only the error type
  // is logged, never request bodies (no personal data in logs).
  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.too.large") {
      return res.status(413).render("error", { message: "The file is too large (max 10 MB)." });
    }
    console.error(`[web] ${err.name}`);
    res.status(500).render("error", { message: "Something went wrong. The error was logged." });
  });

  return Object.assign(app, { extractionsRunning: running });
}

/** Minimal cookie reading, to avoid a dependency for one value. */
function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function sameHost(url: string, host: string | undefined): boolean {
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}

/** Redirect back only within this app (never to another site via the Referer header). */
function safeBack(req: Request): string {
  const referer = req.get("referer");
  if (!referer) return "/";
  try {
    const url = new URL(referer);
    return url.host === req.get("host") ? url.pathname + url.search : "/";
  } catch {
    return "/";
  }
}
