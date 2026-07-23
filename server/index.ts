// Local dashboard API: pick newsletter bodies/links, preview them, send to Kindle.
import express from "express";
import path from "path";
import { loadConfig, ROOT, type Config } from "./config";
import * as store from "./store";
import * as gmail from "./gmail";
import { cleanNewsletterHtml, analyzeNewsletter, domainOf } from "./extract";
import { fetchArticle, FetchError } from "./fetchArticle";
import { checkBounces } from "./bounces";
import { buildEpub, type EpubSection } from "./epub";
import { minutesFor, wordCountOf } from "./stats";

const app = express();
app.disable("x-powered-by");

// The dashboard can read the user's email, so it must only ever answer the
// user's own browser: reject any request whose Host header isn't a loopback
// name (defeats DNS rebinding) and any state-changing request originating
// from another website.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
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
  next();
});
app.use(express.json());

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
    res.status(503).json({ error: String((e as Error).message ?? e) });
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
    res.status(status).json({ error: String((e as Error).message ?? e) });
  }
});

interface SendItem {
  kind: "body" | "link";
  msg_id: string;
  url?: string | null;
}

app.post("/api/send", async (req, res) => {
  const items: SendItem[] = req.body?.items ?? [];
  const bundle: boolean = !!req.body?.bundle && items.length > 1;
  const config = loadConfig();
  const g = gmail.gmailClient();
  const results = [];
  const touched = new Set<string>();

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
        const article = await getArticleCached(item.url!);
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
      store.recordSent(item.msg_id, item.kind, item.url ?? null, shown, "error", detail);
      results.push({ title: shown, ok: false, detail });
    }
  }

  if (bundle && resolved.length > 0) {
    // One book, each item a chapter with its own TOC entry.
    const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const bookTitle = `Reading digest — ${date}`;
    try {
      const epub = await buildEpub(bookTitle, "reader-processor", resolved.map((r) => r.section));
      await gmail.sendEpub(g, config.kindleEmail, bookTitle, epub);
      for (const r of resolved) {
        store.recordSent(r.item.msg_id, r.item.kind, r.item.url ?? null, r.section.title, "sent", `in "${bookTitle}"`);
        touched.add(r.item.msg_id);
        results.push({ title: r.section.title, ok: true, detail: `chapter of "${bookTitle}"` });
      }
    } catch (e) {
      const detail = String((e as Error).message ?? e);
      for (const r of resolved) {
        store.recordSent(r.item.msg_id, r.item.kind, r.item.url ?? null, r.section.title, "error", detail);
        results.push({ title: r.section.title, ok: false, detail });
      }
    }
  } else {
    for (const r of resolved) {
      try {
        const epub = await buildEpub(r.section.title, r.author, [r.section]);
        await gmail.sendEpub(g, config.kindleEmail, r.section.title, epub);
        store.recordSent(r.item.msg_id, r.item.kind, r.item.url ?? null, r.section.title, "sent");
        touched.add(r.item.msg_id);
        results.push({ title: r.section.title, ok: true, detail: "" });
      } catch (e) {
        const detail = String((e as Error).message ?? e);
        store.recordSent(r.item.msg_id, r.item.kind, r.item.url ?? null, r.section.title, "error", detail);
        results.push({ title: r.section.title, ok: false, detail });
      }
    }
  }

  if (touched.size > 0) {
    const labelId = await gmail.ensureLabel(g, config.sentLabel);
    for (const msgId of touched) await gmail.addLabel(g, msgId, labelId);
  }
  res.json({ results });
});

app.get("/api/log", async (_req, res) => {
  try {
    await checkBounces();
  } catch {
    // Offline or not yet authenticated — still show the log we have.
  }
  res.json({ entries: store.recentLog() });
});

// Bounces arrive minutes after a send; keep the log honest between visits.
const bouncePoll = () => checkBounces().catch(() => {});
setTimeout(bouncePoll, 5_000);
setInterval(bouncePoll, 5 * 60 * 1000);

const port = Number(process.env.PORT ?? 8377);
// Loopback only — never reachable from the local network.
app.listen(port, "127.0.0.1", () => {
  console.log(`reader-processor listening on http://localhost:${port}`);
});
