// Fetch a web article and extract its readable content, content-collector
// style: prefer a known text-rich content container (keeps ALL text and
// images), fall back to Mozilla Readability, then clean the result.
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { parseHtml, textOf } from "./html";

export const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Ordered by preference; the first selector with a text-rich element wins.
const CONTENT_SELECTORS = [
  "[data-elementor-type='wp-post']",
  ".learndash-content-body",
  "article",
  "main",
  "[role='main']",
  "#content .entry-content",
  ".post-content",
];

// Elements that are never article content.
const JUNK_SELECTORS = [
  "script", "style", "noscript", "iframe", "svg", "form", "button",
  "nav", "aside", "header", "footer", "[role='navigation']",
  ".screen-reader-text",
].join(",");

export class FetchError extends Error {
  /**
   * Whether hand-pasting the page would actually get around this. False for a
   * bad URL, a PDF, or a timeout — offering the paste dialog there just sends
   * the user off to do work that cannot help.
   */
  readonly pasteable: boolean;
  constructor(message: string, pasteable = false) {
    super(message);
    this.pasteable = pasteable;
  }
}

/**
 * The site answered with a bot wall instead of the article. Worth its own type:
 * these products fingerprint the TLS handshake, so no retry and no amount of
 * header tuning gets through — only the user's own browser will, which is what
 * the paste fallback is for. Saying so beats a bare "HTTP 403", which reads
 * like a broken link and invites pointless retries.
 */
export class BlockedError extends FetchError {
  constructor(message: string) {
    super(message, true);
  }
}

// Substrings that identify a bot wall, mapped to the name worth reporting.
const BLOCK_VENDORS: [string, string][] = [
  ["captcha-delivery.com", "DataDome"],
  ["datadome", "DataDome"],
  ["cdn-cgi/challenge-platform", "Cloudflare"],
  ["cf-browser-verification", "Cloudflare"],
  ["just a moment...", "Cloudflare"],
  ["_incapsula_resource", "Imperva"],
  ["px-captcha", "PerimeterX"],
  ["perimeterx", "PerimeterX"],
  ["please enable js", "a JavaScript bot wall"],
  ["enable javascript and cookies", "a JavaScript bot wall"],
  ["verifying you are human", "a JavaScript bot wall"],
];

/**
 * Name the bot wall behind a response, or null if it looks like an ordinary
 * error. Vendor markers are checked at any status because some walls answer
 * 200 with a challenge page; the status codes stand in as evidence only when
 * no marker is recognisable.
 */
// Statuses where a challenge page is plausible. A 404 or 500 is the origin's
// own error even when Cloudflare has injected its challenge script into the
// response, so matching markers there would report a dead link as a bot wall.
const WALL_STATUSES = new Set([200, 401, 403, 503]);

function detectBotWall(status: number, body: string): string | null {
  if (!WALL_STATUSES.has(status)) return null;
  const hay = body.slice(0, 20_000).toLowerCase();
  for (const [marker, vendor] of BLOCK_VENDORS) {
    if (hay.includes(marker)) return `blocks automated fetching (${vendor})`;
  }
  if (status === 401 || status === 403) {
    return `blocks automated fetching (HTTP ${status})`;
  }
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const PASTE_HINT = 'open it in your browser, then use "Paste article"';

export interface Article {
  url: string;
  title: string;
  html: string;
}

/** Find the most text-rich known content container, or null. */
function pickMainContent(doc: Document): Element | null {
  for (const selector of CONTENT_SELECTORS) {
    let best: Element | null = null;
    let bestLen = 0;
    doc.querySelectorAll(selector).forEach((el) => {
      const len = (el.textContent ?? "").trim().length;
      if (len > bestLen) {
        bestLen = len;
        best = el;
      }
    });
    if (best && bestLen > 200) return best;
  }
  return null;
}

/** Prefer the container's own <h1>, else the page's, else document.title. */
function pickTitle(doc: Document, main: Element): string {
  const h1 = main.querySelector("h1") ?? doc.querySelector("h1");
  const heading = (h1?.textContent ?? "").trim();
  if (heading) return heading;
  return (doc.title || "").split(/\s[|–—]\s/)[0].trim();
}

/** Return the highest-resolution URL from a srcset attribute. */
function pickFromSrcset(srcset: string): string | null {
  const candidates = srcset
    .split(",")
    .map((part) => {
      const [url, descriptor] = part.trim().split(/\s+/);
      const width = descriptor?.endsWith("w")
        ? parseInt(descriptor)
        : descriptor?.endsWith("x")
          ? parseFloat(descriptor) * 1000
          : 0;
      return { url, width: isNaN(width) ? 0 : width };
    })
    .filter((c) => c.url);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.width - a.width);
  return candidates[0].url;
}

/**
 * Clean extracted article HTML (content-collector's cleanHtml): drop junk
 * elements, emoji <img> → character, resolve image/anchor URLs to absolute,
 * flatten srcset, strip presentational attributes. Applied ONLY to fetched
 * web articles — newsletter email bodies are never cleaned this way.
 */
export function cleanArticleHtml(html: string, baseUrl: string): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  doc.querySelectorAll(JUNK_SELECTORS).forEach((el) => el.remove());

  doc.querySelectorAll("img.emoji").forEach((img) => {
    img.replaceWith(doc.createTextNode(img.getAttribute("alt") ?? ""));
  });

  doc.querySelectorAll("img").forEach((img) => {
    const srcset = img.getAttribute("srcset");
    let src = img.getAttribute("src") ?? img.getAttribute("data-src") ?? "";
    if (srcset) src = pickFromSrcset(srcset) ?? src;
    img.removeAttribute("srcset");
    if (src) {
      try {
        img.setAttribute("src", new URL(src, baseUrl).href);
      } catch {
        img.removeAttribute("src");
      }
    }
    if (!img.getAttribute("src")) img.remove();
  });

  doc.querySelectorAll("a[href]").forEach((a) => {
    try {
      const abs = new URL(a.getAttribute("href")!, baseUrl);
      if (abs.protocol === "http:" || abs.protocol === "https:") {
        a.setAttribute("href", abs.href);
      } else {
        a.removeAttribute("href");
      }
    } catch {
      a.removeAttribute("href");
    }
  });

  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name;
      if (
        name === "style" || name === "class" || name === "id" ||
        name.startsWith("data-") || name.startsWith("aria-") ||
        name.startsWith("on") || name === "role"
      ) {
        el.removeAttribute(name);
      }
    }
  });

  return doc.body?.innerHTML ?? html;
}

/**
 * Follow redirects and report where a URL actually lands, ignoring the status —
 * a bot wall still names the destination it refused to serve. Opaque shortcodes
 * (links.tldrnewsletter.com/uegIWW) carry no destination for unwrapTracking to
 * read, so only a request reveals it. Falls back to the input, because a slow
 * resolver must never cost the user a paste.
 */
export async function resolveFinalUrl(url: string): Promise<string> {
  // HEAD first: the redirect chain is all we want and there is no body to
  // download. But a redirector that rejects the method outright never
  // redirects at all, so fall back to GET when HEAD is refused — silently
  // keeping the shortcode is the failure this function exists to prevent.
  for (const method of ["HEAD", "GET"] as const) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers: FETCH_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      return url; // unreachable or timed out; the caller's URL is all we have
    }
    // Nothing here reads the body; drop it so the socket returns to the pool.
    await resp.body?.cancel().catch(() => {});
    if (resp.url && resp.url !== url) return resp.url;
    if (resp.status !== 405 && resp.status !== 501) return url; // HEAD honoured
  }
  return url;
}

export async function fetchArticle(url: string): Promise<Article> {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new FetchError(`not a valid URL: ${url}`);
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new FetchError(`refusing to fetch non-http(s) URL: ${url}`);
  }
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: FETCH_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
  } catch (e) {
    throw new FetchError(`fetch failed: ${e}`);
  }
  const ctype = resp.headers.get("content-type") ?? "";
  const body = await resp.text().catch(() => "");
  const host = hostOf(resp.url);
  if (!resp.ok) {
    // Rate limiting is the one refusal that time alone fixes; calling it a
    // block would send the user off to paste a page a retry would have got.
    if (resp.status === 429) {
      throw new FetchError(`${host} is rate-limiting us (HTTP 429) — wait a few minutes and retry`);
    }
    const wall = detectBotWall(resp.status, body);
    if (wall) throw new BlockedError(`${host} ${wall} — ${PASTE_HINT}`);
    throw new FetchError(`fetch failed: HTTP ${resp.status}`);
  }
  if (!ctype.includes("html") && !/^\s*<(!doctype|html)/i.test(body)) {
    throw new FetchError(`not an HTML page (content-type: ${ctype || "unknown"})`);
  }
  const doc = parseHtml(body, resp.url);

  let rawHtml: string;
  let title: string;
  const main = pickMainContent(doc);
  if (main) {
    rawHtml = main.innerHTML;
    title = pickTitle(doc, main);
  } else {
    const article = new Readability(doc).parse();
    if (!article?.content) {
      // A wall that answers 200 with a challenge page lands here, not above.
      const wall = detectBotWall(resp.status, body);
      if (wall) throw new BlockedError(`${host} ${wall} — ${PASTE_HINT}`);
      throw new FetchError(
        `couldn't extract readable content from this page — ${PASTE_HINT}`, true,
      );
    }
    rawHtml = article.content;
    title = (article.title ?? "").trim();
  }

  const html = cleanArticleHtml(rawHtml, resp.url);
  const textLength = textOf(html).trim().length;
  if (textLength < 200) {
    const wall = detectBotWall(resp.status, body);
    if (wall) throw new BlockedError(`${host} ${wall} — ${PASTE_HINT}`);
    throw new FetchError(
      `extraction produced almost no text (paywall or JS-only page?) — ${PASTE_HINT}`, true,
    );
  }
  // A scraped <h1> can span nested elements (banners, badges), yielding a
  // multi-line textContent; collapse it so titles are always one line.
  return { url: resp.url, title: (title || url).replace(/\s+/g, " ").trim(), html };
}
