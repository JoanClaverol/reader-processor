// Parse newsletter HTML: extract candidate article links, clean bodies.
import { JSDOM } from "jsdom";
import { parseHtml, textOfDoc, wordCountOfText } from "./html";

// Substrings in link text that mark navigation/housekeeping, not articles.
const JUNK_TEXT = [
  "unsubscribe", "view in browser", "view online", "read online", "read in app",
  "open in app", "privacy policy", "terms of", "manage preferences",
  "update preferences", "update your preferences", "email preferences",
  "advertise", "sponsor", "share this", "forward to a friend", "sign up",
  "subscribe", "app store", "google play", "follow us", "why did i get this",
  "add us to your address book", "upgrade", "gift a subscription",
  "leave a comment", "view comments", "refer a friend", "invite friends",
  // Spanish newsletters (La Bonilista, Nexo Europa…)
  "ver este mail en tu navegador", "ver en el navegador", "darse de baja",
  "date de baja", "cancelar suscripción", "cancela tu suscripción",
  "actualiza tus preferencias", "suscríbete", "leer en la app",
  "vista previa", "reclamar mi post", "mejora tu suscripción",
  "regístrate aquí", "see more notes",
];

// Exact link texts that are actions, not articles (Substack footers etc.).
const ACTION_TEXT = new Set([
  "share", "like", "comment", "restack", "reply", "listen", "watch",
  "read more", "learn more", "click here", "see more", "donate",
  "substack", "twitter (x)", "twitter", "facebook", "linkedin", "instagram",
]);

// Hosts that are essentially never the article itself.
const JUNK_HOSTS = [
  "twitter.com", "x.com", "facebook.com", "instagram.com", "linkedin.com",
  "threads.net", "youtube.com", "youtu.be", "apps.apple.com", "play.google.com",
  "mailchi.mp", "list-manage.com", "sendgrid.net", "advertise.tldr.tech",
  "refer.tldr.tech",
];

const READ_TIME_RE = /\s*\((\d+)\s*(?:minute|min)\s*read\)\s*/i;

export interface ExtractedLink {
  url: string;
  title: string;
  minutes: number | null;
  domain: string;
  junk: boolean;
}

const NOT_A_DESTINATION = /^(utm_|ref$|referr?er$|source$|via$|share|og_|canonical$)/i;

/** Resolve tracking-wrapper URLs (TLDR, Mailchimp-style) to their destination. */
export function unwrapTracking(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const [key, value] of parsed.searchParams) {
    // A real article can carry a URL in an attribution param
    // (…?ref=https://x.com); that names where the reader came from, not where
    // the link goes, so it must not replace the article.
    if (NOT_A_DESTINATION.test(key)) continue;
    if (value.startsWith("http://") || value.startsWith("https://")) return value;
  }
  for (const segment of parsed.pathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      continue;
    }
    if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
  }
  return url;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isJunk(url: string, text: string, subject: string): boolean {
  const low = text.toLowerCase().trim();
  if (JUNK_TEXT.some((j) => low.includes(j))) return true;
  if (ACTION_TEXT.has(low)) return true;
  if (low.startsWith("http://") || low.startsWith("https://")) return true;
  if (subject && low === subject.toLowerCase().trim()) return true;
  const host = domainOf(url);
  if (JUNK_HOSTS.some((j) => host === j || host.endsWith("." + j))) return true;
  // Short, few-word anchors ("World Bank") are almost always attribution/nav.
  if (low.split(/\s+/).length < 4 && low.length < 25) return true;
  return false;
}

/** Links plus body word count, from a single parse of the email HTML. */
export function analyzeNewsletter(html: string, subject = ""): {
  links: ExtractedLink[];
  wordCount: number;
} {
  const doc = parseHtml(html);
  return {
    links: extractLinksFromDoc(doc, subject),
    wordCount: wordCountOfText(textOfDoc(doc)),
  };
}

/** Return likely-article links, deduplicated, junk flagged (not dropped). */
export function extractLinks(html: string, subject = ""): ExtractedLink[] {
  return extractLinksFromDoc(parseHtml(html), subject);
}

function extractLinksFromDoc(doc: Document, subject: string): ExtractedLink[] {
  const seen = new Map<string, string>();
  const order: string[] = [];
  for (const a of doc.querySelectorAll("a[href]")) {
    let url = (a.getAttribute("href") ?? "").trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    url = unwrapTracking(url);
    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 4) continue;
    const prev = seen.get(url);
    if (prev === undefined) {
      seen.set(url, text);
      order.push(url);
    } else if (text.length > prev.length) {
      seen.set(url, text); // keep the most descriptive anchor text
    }
  }
  return order.map((url) => {
    const text = seen.get(url)!;
    const match = READ_TIME_RE.exec(text);
    return {
      url,
      title: text.replace(READ_TIME_RE, " ").trim(),
      minutes: match ? parseInt(match[1], 10) : null,
      domain: domainOf(url),
      junk: isJunk(url, text, subject),
    };
  });
}

/**
 * Light-touch cleanup that keeps the newsletter's own layout intact:
 * only scripts, tracking pixels, and hidden elements are removed.
 */
export function cleanNewsletterHtml(html: string, _subject = ""): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  for (const el of [...doc.querySelectorAll("script, iframe, form")]) el.remove();
  for (const img of [...doc.querySelectorAll("img")]) {
    const w = img.getAttribute("width") ?? "";
    const h = img.getAttribute("height") ?? "";
    if (w === "0" || w === "1" || h === "0" || h === "1") {
      img.remove();
      continue;
    }
    img.removeAttribute("srcset");
  }
  for (const el of [...doc.querySelectorAll("[style]")]) {
    const style = (el.getAttribute("style") ?? "").replace(/\s+/g, "").toLowerCase();
    if (style.includes("display:none") || style.includes("visibility:hidden")) el.remove();
  }
  return doc.body?.innerHTML ?? html;
}
