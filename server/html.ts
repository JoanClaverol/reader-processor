// Shared HTML-to-text parsing. Real-world email and article markup makes
// jsdom's default console spam CSS-parse errors, so every parse here goes
// through one quiet VirtualConsole (fetchArticle previously did this locally).
import { JSDOM, VirtualConsole } from "jsdom";

const quiet = new VirtualConsole();

export function parseHtml(html: string, url?: string): Document {
  return new JSDOM(html, { url, virtualConsole: quiet }).window.document;
}

/** Raw textContent of an already-parsed document's body. */
export function textOfDoc(doc: Document): string {
  return doc.body?.textContent ?? "";
}

/** Raw textContent of an HTML string's body. */
export function textOf(html: string): string {
  return textOfDoc(parseHtml(html));
}

/** Word count of extracted text (whitespace-collapsed). */
export function wordCountOfText(text: string): number {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed ? collapsed.split(" ").length : 0;
}
