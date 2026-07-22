// Word count / reading time, ported from content-collector's stats.ts.
import { JSDOM } from "jsdom";

export function wordCountOf(html: string): number {
  const doc = new JSDOM(html).window.document;
  const text = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  return text ? text.split(" ").length : 0;
}

/** Rough reading time at ~220 wpm. */
export function minutesFor(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 220));
}
