// Amazon reports Send-to-Kindle failures asynchronously: the Gmail send
// succeeds, then minutes later do-not-reply@amazon.com mails a bounce notice
// quoting the attachment filename and an error code (e.g. E013). Poll for
// those notices and flip the matching send-log rows to 'error' so the
// dashboard reflects actual delivery, not just Gmail acceptance.
//
// Matching works backwards from our own records: every send stores the exact
// attachment filename, and a notice matches a send when its text mentions
// that filename. That way nothing depends on the wording or layout of
// Amazon's email — only on it quoting the filename at all.
import * as gmail from "./gmail";
import { textOf } from "./html";
import * as store from "./store";

const BOUNCE_QUERY =
  'from:do-not-reply@amazon.com subject:"There was a problem with the document" newer_than:3d';

// Gmail's from: operator also matches display names, so a third party could
// craft mail that satisfies BOUNCE_QUERY; require the real address too.
const AMAZON_FROM = /(^|<|\s)do-not-reply@amazon\.com(>|$|\s)/i;

// A bounce only ever refers to a recent send; don't touch older same-name rows.
const MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

// Real notices are a few KB; cap what reaches JSDOM so an oversized hostile
// email can't stall the event loop.
const MAX_HTML_CHARS = 200_000;

function inWindow(row: store.SentRow, bounceMs: number): boolean {
  if (isNaN(bounceMs)) return true; // notice had no parseable Date — don't drop the match
  const created = new Date(row.created_at + "Z").getTime();
  return created <= bounceMs && created >= bounceMs - MATCH_WINDOW_MS;
}

/**
 * Rows to flip for one mentioned filename: only the earliest still-'sent'
 * send (a bounce answers the oldest unanswered attempt, so a later resend of
 * the same title is left alone), but all rows sharing that timestamp — a
 * bundle writes one row per chapter for the same attachment.
 */
function rowsToFlip(rows: store.SentRow[], bounceMs: number): store.SentRow[] {
  const matching = rows.filter((r) => inWindow(r, bounceMs));
  const earliest = matching.reduce(
    (a, b) => (a === null || b.created_at < a.created_at ? b : a),
    null as store.SentRow | null,
  );
  return matching.filter((r) => r.created_at === earliest?.created_at);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Substring alone would let "Foo.epub" match a mention of "My Foo.epub".
const mentions = (text: string, filename: string) =>
  new RegExp(`(?:^|[^\\w])${escapeRegex(filename)}`).test(text);

export interface NoticeResult {
  flips: store.SentRow[];
  code: string;
}

/**
 * Pure matching core: which rows does this notice flip, and why. Takes every
 * row that has a filename regardless of status — already-resolved sends still
 * mask their filename's mention in the text — but only 'sent' rows can flip.
 */
export function noticeFlips(
  text: string, dateIso: string, rows: store.SentRow[],
): NoticeResult {
  const code = /due to\s+(E\d+)/.exec(text)?.[1] ?? "unknown error";
  const bounceMs = new Date(dateIso + "Z").getTime();

  const byFilename = new Map<string, store.SentRow[]>();
  for (const row of rows) {
    if (!row.filename) continue; // rows from before the filename column existed
    const group = byFilename.get(row.filename) ?? [];
    group.push(row);
    byFilename.set(row.filename, group);
  }

  // Longest filename first, consuming matches from the text, so a filename
  // that is a tail of another ("Article.epub" vs "My Great Article.epub")
  // can't claim the longer one's mention.
  const flips: store.SentRow[] = [];
  let remaining = text;
  for (const filename of [...byFilename.keys()].sort((a, b) => b.length - a.length)) {
    if (!mentions(remaining, filename)) continue;
    remaining = remaining.split(filename).join(" ");
    const pending = byFilename.get(filename)!.filter((r) => r.status === "sent");
    flips.push(...rowsToFlip(pending, bounceMs));
  }
  return { flips, code };
}

let inFlight: Promise<number> | null = null;

/** Process unseen bounce notices; returns how many log rows were flipped. */
export function checkBounces(): Promise<number> {
  inFlight ??= doCheck().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doCheck(): Promise<number> {
  const g = gmail.gmailClient();
  const ids = await gmail.searchMessageIds(g, BOUNCE_QUERY);
  const unseen = ids.filter((id) => !store.isBounceProcessed(id));
  const msgs = await Promise.all(unseen.map((id) => gmail.fetchMessage(g, id)));
  let flipped = 0;
  for (const msg of msgs) {
    if (AMAZON_FROM.test(msg.sender)) {
      const text = textOf(msg.html.slice(0, MAX_HTML_CHARS));
      const { flips, code } = noticeFlips(text, msg.date_iso, store.sentRowsWithFilename());
      for (const row of flips) {
        store.updateSentStatus(row.id, "error", `Kindle bounced it: ${code}`);
      }
      flipped += flips.length;
      if (flips.length === 0) {
        // Nothing to flip — record the notice itself so it isn't silently lost.
        store.recordSent(msg.id, "bounce", null, "Kindle bounce notice", "error",
          `No matching send found (${code})`);
      }
    }
    store.markBounceProcessed(msg.id);
  }
  return flipped;
}
