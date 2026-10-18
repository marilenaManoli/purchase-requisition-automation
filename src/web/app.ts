import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/db.ts";
import type { ReferenceData } from "../db/queries.ts";
import type { LlmClient } from "../extract/llm.ts";
import { STATES } from "../workflow/states.ts";
import { employeeName, formatMoney, inboxRows, requisitionDetail } from "./views.ts";

// The web app. `createApp` takes its dependencies as arguments, so tests can
// run it against an in-memory database and a fake LLM.

export interface AppDeps {
  db: Db;
  ref: ReferenceData;
  llm: LlmClient;
}

const ACT_AS_COOKIE = "actAs";

export function createApp(deps: AppDeps): express.Express {
  const { db, ref } = deps;
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", fileURLToPath(new URL("./views", import.meta.url)));
  app.use(express.urlencoded({ extended: false })); // HTML form posts

  // "Act as": who is using the app (assumption 5: stands in for a real login).
  // Every template gets `actor` and the list of people to switch to.
  app.use((req, res, next) => {
    const chosen = readCookie(req, ACT_AS_COOKIE);
    const actor = chosen && (chosen === "clerk" || ref.employees.some((e) => e.id === chosen)) ? chosen : "clerk";
    res.locals.actor = actor;
    res.locals.actorName = actor === "clerk" ? "Clerk" : employeeName(ref, actor);
    res.locals.people = ref.employees.filter((e) => e.role !== "requester_only");
    res.locals.formatMoney = formatMoney;
    next();
  });

  app.post("/act-as", (req, res) => {
    const who = String(req.body.actor ?? "clerk");
    res.cookie(ACT_AS_COOKIE, who, { httpOnly: true, sameSite: "lax" });
    res.redirect(safeBack(req));
  });

  app.get("/", (req, res) => {
    const state = typeof req.query.state === "string" && (STATES as readonly string[]).includes(req.query.state) ? req.query.state : undefined;
    const mine = req.query.mine === "1" && res.locals.actor !== "clerk";
    const rows = inboxRows(db, ref, { state, waitingFor: mine ? res.locals.actor : undefined });
    res.render("inbox", { rows, states: STATES, selectedState: state ?? "", mine });
  });

  app.get("/requisitions/:id", (req, res, next) => {
    const detail = requisitionDetail(db, ref, Number(req.params.id));
    if (!detail) return next(); // falls through to the 404 handler
    res.render("detail", { r: detail });
  });

  app.use((_req, res) => {
    res.status(404).render("error", { message: "Not found." });
  });

  // Express 5 passes errors from async handlers here too. Only the error type
  // is logged, never request bodies (no personal data in logs).
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`[web] ${err.name}`);
    res.status(500).render("error", { message: "Something went wrong. The error was logged." });
  });

  return app;
}

/** Minimal cookie reading, to avoid a dependency for one value. */
function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
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
