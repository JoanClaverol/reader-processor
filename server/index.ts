// Local dashboard API: pick newsletter bodies/links, preview them, send to Kindle.
import express from "express";
import path from "path";
import { loadConfig, ROOT, type Config } from "./config";
import * as store from "./store";
import * as gmail from "./gmail";
import { cleanNewsletterHtml, analyzeNewsletter, domainOf } from "./extract";
import { fetchArticle, cleanArticleHtml, resolveFinalUrl, FetchError } from "./fetchArticle";
import { textOf, wordCountOfText } from "./html";
import { checkBounces } from "./bounces";
import { buildEpub, type EpubSection } from "./epub";
import { minutesFor, wordCountOf } from "./stats";

const app = express();
app.disable("x-powered-by");

// The dashboard can read the user's email, so it must only ever answer the
// user's own browser: reject any request whose Host header isn't a loopback
// name (defeats DNS rebinding) and any state-changing request originating
// from another website. READER_PROCESSOR_HOSTS (comma-separated) adds names
// for a trusted private proxy, e.g. a `tailscale serve` *.ts.net hostname.
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  ...(process.env.READER_PROCESSOR_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
]);
app.use((req, res, next) => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(host)) {
    return res.status(403).json({ error: "Forbidden: non-local Host header" });
  }
  const origin = req.headers.origin;
  if (origin && req.method !== "GET") {
    let ok = false;
    try {
      ok = LOCAL_HOSTS.has(new URL(origin).hostname);
    } catch {
      ok = false;
    }
    if (!ok) return res.status(403).json({ error: "Forbidden: cross-origin request" });
  }
  // Origin is absent on cross-site GETs, so the check above can't stop another
  // website from making the server fetch arbitrary URLs (including LAN hosts)
  // via /api/preview/article. Browsers label every such request with
  // Sec-Fetch-Site; only the dashboard's own fetches say same-origin.
  const site = req.headers["sec-fetch-site"];
  if (req.path.startsWith("/api/") && (site === "cross-site" || site === "same-site")) {
    return res.status(403).json({ error: "Forbidden: cross-site request" });
  }
  next();
});
// A pasted article arrives as one JSON body, well past the 100kb default.
app.use(express.json({ limit: "8mb" }));

const STATIC_DIR = path.join(ROOT, "public");
app.use("/static", express.static(STATIC_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));

function parseSender(from: string): string {
  const m = /^"?([^"<]*)"?\s*<[^>]+>\s*$/.exec(from);
  const name = m?.[1]?.trim();
  return name || from.replace(/[<>]/g, "").trim();
}

async function getMessage(g: gmail.Gmail, msgId: string): Promise<store.CachedMessage> {
  const cached = store.getCachedMessages([msgId]).get(msgId);
  if (cached) return cached;
  const msg = await gmail.fetchMessage(g, msgId);
  store.cacheMessage(msg);
  return msg;
}

async function getArticleCached(url: string) {
  const cached = store.getArticle(url);
  if (cached) return { url: cached.final_url, title: cached.title, html: cached.html };
  const article = await fetchArticle(url);
  store.putArticle(url, article.url, article.title, article.html, wordCountOf(article.html));
  return article;
}

async function loadNewsletters(config: Config) {
  const g = gmail.gmailClient();
  const ids = await gmail.listNewsletterIds(g, config.sourceLabel, config.daysBack);
  const cached = store.getCachedMessages(ids);
  const messages: store.CachedMessage[] = [];
  for (const id of ids) {
    let msg = cached.get(id);
    if (!msg) {
      msg = await gmail.fetchMessage(g, id);
      store.cacheMessage(msg);
    }
    messages.push(msg);
  }
  const sent = store.sentKeys();
  const wordCounts = store.articleWordCounts();
  return messages
    .map((msg) => {
      const { links, wordCount } = analyzeNewsletter(msg.html, msg.subject);
      return {
        id: msg.id,
        sender_display: parseSender(msg.sender),
        subject: msg.subject,
        date_iso: msg.date_iso,
        body_sent: sent.has(`body:${msg.id}`),
        minutes: minutesFor(wordCount),
        links: links.map((link) => ({
          ...link,
          minutes:
            link.minutes ??
            (wordCounts.has(link.url) ? minutesFor(wordCounts.get(link.url)!) : null),
          sent: sent.has(`link:${link.url}`),
        })),
      };
    })
    .sort((a, b) => (a.date_iso < b.date_iso ? 1 : -1));
}

app.get("/api/newsletters", async (_req, res) => {
  try {
    const config = loadConfig();
    res.json({
      newsletters: await loadNewsletters(config),
      kindle_email: config.kindleEmail,
      days_back: config.daysBack,
    });
  } catch (e) {
    const authRequired = gmail.isAuthError(e);
    res.status(authRequired ? 401 : 503).json({
      error: String((e as Error).message ?? e),
      code: authRequired ? "gmail_auth_required" : "setup_required",
    });
  }
});

app.get("/api/preview/body/:msgId", async (req, res) => {
  try {
    const g = gmail.gmailClient();
    const msg = await getMessage(g, req.params.msgId);
    res.json({ title: msg.subject, html: cleanNewsletterHtml(msg.html, msg.subject) });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

app.get("/api/preview/article", async (req, res) => {
  const url = String(req.query.url ?? "");
  try {
    const article = await getArticleCached(url);
    res.json({ title: article.title, html: article.html, url: article.url });
  } catch (e) {
    const status = e instanceof FetchError ? 502 : 500;
    res.status(status).json({
      error: String((e as Error).message ?? e),
      // Lets the dashboard offer the paste dialog only where it can help.
      pasteable: e instanceof FetchError && e.pasteable,
    });
  }
});

// A bot-walled article can still be read in the user's own browser. Accept a
// paste of what they see there into the same cache a successful fetch fills,
// so preview and send treat it like any other article from then on.
app.post("/api/article/paste", async (req, res) => {
  const url = String(req.body?.url ?? "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "not a valid URL" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(400).json({ error: "URL must be http(s)" });
  }
  // Resolve first: a newsletter shortcode must not end up as the article's
  // host, or the EPUB credits the tracker and relative images resolve there.
  const finalUrl = await resolveFinalUrl(url);
  const html = cleanArticleHtml(String(req.body?.html ?? ""), finalUrl);
  // One text extraction feeds both the length check and the word count: each
  // is a full synchronous parse, and this body can be megabytes.
  const text = textOf(html).trim();
  if (text.length < 200) {
    return res
      .status(400)
      .json({ error: "pasted content is too short — needs at least 200 characters of text" });
  }
  const title =
    String(req.body?.title ?? "").replace(/\s+/g, " ").trim() || domainOf(finalUrl);
  // Keyed by the URL the dashboard asked for, so preview and send find it.
  store.putArticle(url, finalUrl, title, html, wordCountOfText(text));
  res.json({ title, url: finalUrl });
});

/** `warning: true` marks bookkeeping that failed after a successful send. */
interface SendResult {
  title: string;
  ok: boolean;
  detail: string;
  warning?: boolean;
}

interface SendItem {
  kind: "body" | "link";
  msg_id: string;
  url?: string | null;
}

function isSendItem(x: unknown): x is SendItem {
  const item = x as Partial<SendItem> | null;
  return (
    typeof item?.msg_id === "string" &&
    (item.kind === "body" || (item.kind === "link" && typeof item.url === "string"))
  );
}

app.post("/api/send", async (req, res) => {
  const items: unknown[] = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.every(isSendItem)) {
    return res.status(400).json({ error: "each item needs a msg_id and kind body|link (links need a url)" });
  }
  const bundle: boolean = !!req.body?.bundle && items.length > 1;
  // Setup problems (no config, no token) must reach the dashboard as JSON, not
  // as Express's HTML error page.
  let config: Config;
  let g: gmail.Gmail;
  try {
    config = loadConfig();
    g = gmail.gmailClient();
  } catch (e) {
    const authRequired = gmail.isAuthError(e);
    return res.status(authRequired ? 401 : 503).json({
      error: String((e as Error).message ?? e),
      code: authRequired ? "gmail_auth_required" : "setup_required",
    });
  }
  const results: SendResult[] = [];
  const touched = new Set<string>();

  // The book is in Amazon's hands before this row is ever written, so a failed
  // write must never be reported as a failed send. It used to be: recordSent
  // sat inside the same try as sendEpub, and that catch called recordSent
  // again, so a database that refused one write refused both, the second throw
  // escaped the handler, and a delivered book left no row at all — which is
  // how a real Kindle bounce later arrived with nothing to match it against.
  // Same rule as the labelling below: bookkeeping reports, never overrules.
  const logSent = (
    item: SendItem,
    title: string,
    status: string,
    detail = "",
    filename: string | null = null,
  ) => {
    try {
      store.recordSent(item.msg_id, item.kind, item.url ?? null, title, status, detail, filename);
    } catch (e) {
      results.push({
        title: "send log",
        ok: false,
        warning: true,
        detail: `couldn't record "${title}" as ${status} — ${String((e as Error).message ?? e)}`,
      });
    }
  };

  // Resolve every item to a section (title + faithful html + source).
  const resolved: { item: SendItem; section: EpubSection; author: string }[] = [];
  for (const item of items) {
    let title: string | null = null;
    let url: string | null = item.url ?? null;
    try {
      const msg = await getMessage(g, item.msg_id);
      if (item.kind === "body") {
        resolved.push({
          item,
          section: { title: msg.subject, html: cleanNewsletterHtml(msg.html, msg.subject) },
          author: parseSender(msg.sender),
        });
      } else {
        const article = await getArticleCached(item.url as string);
        title = article.title;
        url = article.url;
        resolved.push({
          item,
          section: { title: article.title, html: article.html, sourceUrl: article.url },
          author: domainOf(article.url),
        });
      }
    } catch (e) {
      const shown = title ?? url ?? item.msg_id;
      const detail = String((e as Error).message ?? e);
      logSent(item, shown, "error", detail);
      results.push({ title: shown, ok: false, detail });
    }
  }

  if (bundle && resolved.length > 0) {
    // One book, each item a chapter with its own TOC entry.
    const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const bookTitle = `Reading digest — ${date}`;
    // Only the build and the send belong in the try — see logSent above.
    let filename: string | null = null;
    let failure = "";
    try {
      const epub = await buildEpub(bookTitle, "reader-processor", resolved.map((r) => r.section));
      filename = await gmail.sendEpub(g, config.kindleEmail, bookTitle, epub);
    } catch (e) {
      failure = String((e as Error).message ?? e);
    }
    for (const r of resolved) {
      if (filename === null) {
        logSent(r.item, r.section.title, "error", failure);
        results.push({ title: r.section.title, ok: false, detail: failure });
        continue;
      }
      logSent(r.item, r.section.title, "sent", `in "${bookTitle}"`, filename);
      touched.add(r.item.msg_id);
      results.push({ title: r.section.title, ok: true, detail: `chapter of "${bookTitle}"` });
    }
  } else {
    for (const r of resolved) {
      let filename: string;
      try {
        const epub = await buildEpub(r.section.title, r.author, [r.section]);
        filename = await gmail.sendEpub(g, config.kindleEmail, r.section.title, epub);
      } catch (e) {
        const detail = String((e as Error).message ?? e);
        logSent(r.item, r.section.title, "error", detail);
        results.push({ title: r.section.title, ok: false, detail });
        continue;
      }
      logSent(r.item, r.section.title, "sent", "", filename);
      touched.add(r.item.msg_id);
      results.push({ title: r.section.title, ok: true, detail: "" });
    }
  }

  // Everything above has already been emailed and recorded as 'sent'. A Gmail
  // hiccup here used to escape the handler, so Express answered with an HTML
  // 500, the dashboard failed to parse it and reported every delivered book as
  // a failure. Labelling is bookkeeping: report it, never let it rewrite the
  // outcome. Per-message try/catch so one bad id can't skip the rest.
  if (touched.size > 0) {
    const warn = (detail: string) =>
      results.push({ title: `"${config.sentLabel}" label`, ok: false, warning: true, detail });
    try {
      const labelId = await gmail.ensureLabel(g, config.sentLabel);
      const failed = (
        await Promise.all(
          [...touched].map((msgId) =>
            gmail.addLabel(g, msgId, labelId).then(() => null, () => msgId)),
        )
      ).filter((id): id is string => id !== null);
      if (failed.length > 0) {
        warn(`couldn't label ${failed.length} of ${touched.size} message(s) — everything above was still sent`);
      }
    } catch (e) {
      warn(`${String((e as Error).message ?? e)} — everything above was still sent`);
    }
  }
  res.json({ results });
});

app.get("/api/log", (_req, res) => {
  res.json({ entries: store.recentLog() });
});

// Bounces arrive minutes after a send; the background poll keeps the log
// honest so /api/log stays a plain local read (never blocks on Gmail).
const bouncePoll = () => checkBounces().catch(() => {});
setTimeout(bouncePoll, 5_000);
setInterval(bouncePoll, 5 * 60 * 1000);

const port = Number(process.env.PORT ?? 8377);
// Loopback only — never reachable from the local network.
app.listen(port, "127.0.0.1", () => {
  console.log(`reader-processor listening on http://localhost:${port}`);
});
