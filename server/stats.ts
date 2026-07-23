// Word count / reading time, ported from content-collector's stats.ts.
import { textOf, wordCountOfText } from "./html";

export function wordCountOf(html: string): number {
  return wordCountOfText(textOf(html));
}

/** Rough reading time at ~220 wpm. */
export function minutesFor(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 220));
}
