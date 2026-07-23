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

export class FetchError extends Error {}

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
  if (!resp.ok) throw new FetchError(`fetch failed: HTTP ${resp.status}`);
  const ctype = resp.headers.get("content-type") ?? "";
  const body = await resp.text();
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
      throw new FetchError("couldn't extract readable content from this page");
    }
    rawHtml = article.content;
    title = (article.title ?? "").trim();
  }

  const html = cleanArticleHtml(rawHtml, resp.url);
  const textLength = textOf(html).trim().length;
  if (textLength < 200) {
    throw new FetchError("extraction produced almost no text (paywall or JS-only page?)");
  }
  return { url: resp.url, title: title || url, html };
}
