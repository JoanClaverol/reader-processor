// Amazon reports Send-to-Kindle failures asynchronously: the Gmail send
// succeeds, then minutes later do-not-reply@amazon.com mails a bounce notice
// quoting the attachment filename and an error code (e.g. E013). Poll for
// those notices and flip the matching send-log rows to 'error' so the
// dashboard reflects actual delivery, not just Gmail acceptance.
import { JSDOM } from "jsdom";
import * as gmail from "./gmail";
import * as store from "./store";

const BOUNCE_QUERY =
  'from:do-not-reply@amazon.com subject:"There was a problem with the document" newer_than:3d';

// A bounce only ever refers to a recent send; don't touch older same-title rows.
const MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The attachment name a send-log row went out under (bundles use the book title). */
function filenameBase(row: store.SentRow): string {
  const bundle = /^in "(.+)"$/.exec(row.detail ?? "");
  return gmail.epubFilenameBase(bundle?.[1] ?? row.title ?? "");
}

/** Rows sent in the window before the bounce whose filename the notice quotes. */
function matchRows(name: string, bounceIso: string): store.SentRow[] {
  const windowStart = new Date(bounceIso + "Z").getTime() - MATCH_WINDOW_MS;
  return store.sentRowsByStatus("sent").filter((row) => {
    if (filenameBase(row) !== name) return false;
    const created = new Date(row.created_at + "Z").getTime();
    return created <= new Date(bounceIso + "Z").getTime() && created >= windowStart;
  });
}

/** Process unseen bounce notices; returns how many log rows were flipped. */
export async function checkBounces(): Promise<number> {
  const g = gmail.gmailClient();
  const ids = await gmail.searchMessageIds(g, BOUNCE_QUERY);
  let flipped = 0;
  for (const id of ids) {
    if (store.isBounceProcessed(id)) continue;
    const msg = await gmail.fetchMessage(g, id);
    const text = new JSDOM(msg.html).window.document.body.textContent ?? "";
    const code = /due to\s+(E\d+[^:*]*)/.exec(text)?.[1]?.trim() ?? "unknown error";
    const names = [...text.matchAll(/(?:^|\n|\*)\s*([^\n*]+?)\.epub/g)].map((m) => m[1].trim());
    for (const name of new Set(names)) {
      for (const row of matchRows(name, msg.date_iso)) {
        store.updateSentStatus(row.id, "error", `Kindle bounced it: ${code}`);
        flipped++;
      }
    }
    store.markBounceProcessed(id);
  }
  return flipped;
}
