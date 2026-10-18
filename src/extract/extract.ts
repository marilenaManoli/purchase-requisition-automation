import { z } from "zod";
import { renderSourceText, type SourceDocument } from "../ingest/sourceDocument.ts";
import { findUnverifiedValues, type UnverifiedValue } from "./evidence.ts";
import type { LlmClient } from "./llm.ts";
import { buildMessages, retryMessage } from "./prompt.ts";
import { ExtractionSchema, extractionJsonSchema, type Extraction } from "./schema.ts";

const MAX_ATTEMPTS = 2; // first try + one retry with the validation error

export type ExtractionOutcome =
  | {
      ok: true;
      extraction: Extraction;
      unverified: UnverifiedValue[];
      attempts: number;
      rawOutput: string;
    }
  | {
      ok: false;
      // no_content:      nothing readable, the LLM was not called       → needs review
      // invalid_output:  the model's answer failed validation twice     → needs review
      // llm_unavailable: server down / timeout: an infrastructure issue → retry later
      kind: "no_content" | "invalid_output" | "llm_unavailable";
      message: string;
      attempts: number;
      rawOutput: string | null; // kept for debugging; never shown as data
    };

/** One LLM extraction, validated, with every value checked against the source. */
export async function extractRequisition(doc: SourceDocument, llm: LlmClient): Promise<ExtractionOutcome> {
  if (!hasReadableContent(doc)) {
    return { ok: false, kind: "no_content", message: "No readable text in body or attachments", attempts: 0, rawOutput: null };
  }

  const sourceText = renderSourceText(doc);
  const messages = buildMessages(sourceText);
  let rawOutput: string | null = null;
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      rawOutput = await llm.chat(messages, { jsonSchema: extractionJsonSchema });
    } catch (err) {
      // Not the model's fault, so no retry with feedback; the caller can try again later.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "llm_unavailable", message: `LLM call failed: ${message}`, attempts: attempt, rawOutput };
    }

    const parsed = parseModelOutput(rawOutput);
    if (parsed.ok) {
      return {
        ok: true,
        extraction: parsed.extraction,
        unverified: findUnverifiedValues(parsed.extraction, sourceText),
        attempts: attempt,
        rawOutput,
      };
    }

    lastError = parsed.error;
    // Show the model its own answer and what was wrong with it.
    messages.push({ role: "assistant", content: rawOutput }, retryMessage(parsed.error));
  }

  return {
    ok: false,
    kind: "invalid_output",
    message: `Extraction failed after ${MAX_ATTEMPTS} attempts: ${lastError}`,
    attempts: MAX_ATTEMPTS,
    rawOutput,
  };
}

type ParseResult = { ok: true; extraction: Extraction } | { ok: false; error: string };

/** Garbage in any form (not JSON, wrong shape, wrong types) becomes an error message. */
export function parseModelOutput(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "The answer is not valid JSON." };
  }
  const result = ExtractionSchema.safeParse(json);
  if (!result.success) {
    // prettifyError lists each problem with its path, e.g. "✖ Invalid input → at line_items[0].quantity".
    return { ok: false, error: z.prettifyError(result.error).slice(0, 2000) };
  }
  return { ok: true, extraction: result.data };
}

function hasReadableContent(doc: SourceDocument): boolean {
  return doc.body.trim() !== "" || doc.attachments.some((a) => a.text !== null);
}
