import { extractText } from "unpdf";

// A "discriminated union": check `ok` and TypeScript knows which other fields
// exist. Failure is a normal result here, not an exception, because an
// unreadable PDF is something the clerk needs to see, not a crash.
export type PdfTextResult =
  | { ok: true; text: string; pages: number }
  | { ok: false; reason: string };

// Below this many characters we assume there is no real text layer.
const MIN_TEXT_CHARS = 20;

/** Extracts the text layer of a PDF. Scanned (image-only) PDFs are out of scope. */
export async function pdfToText(bytes: Uint8Array): Promise<PdfTextResult> {
  try {
    const { text, totalPages } = await extractText(bytes, { mergePages: true });
    if (text.trim().length < MIN_TEXT_CHARS) {
      return { ok: false, reason: "PDF has no text layer (probably scanned); OCR is out of scope" };
    }
    return { ok: true, text: text.trim(), pages: totalPages };
  } catch {
    return { ok: false, reason: "PDF could not be read (damaged or encrypted)" };
  }
}
