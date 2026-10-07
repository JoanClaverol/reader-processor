// EPUB builder adapted from content-collector's extension/src/lib/epub.ts:
// JSZip-built EPUB 3 with NCX fallback, book CSS, embedded images. The only
// omission is the canvas-drawn cover (no canvas in Node).
import JSZip from "jszip";
import { JSDOM } from "jsdom";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { FETCH_HEADERS } from "./fetchArticle";

const BOOK_CSS = `
body { font-family: Georgia, "Times New Roman", serif; line-height: 1.6; margin: 5%; }
h1, h2, h3 { line-height: 1.25; }
img { max-width: 100%; height: auto; }
figure { margin: 1em 0; text-align: center; }
figcaption { font-size: 0.85em; color: #666; }
blockquote { border-left: 3px solid #ccc; margin: 1em 0; padding-left: 1em; color: #555; }
pre { white-space: pre-wrap; word-wrap: break-word; background: #f4f4f4; padding: 0.5em; }
code { font-family: "Courier New", monospace; }
a { color: inherit; }
.source-note { font-size: 0.8em; color: #888; margin-top: 2em; border-top: 1px solid #ddd; padding-top: 0.5em; }
`;

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const MAX_IMAGES = 25;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface ImageRec {
  path: string;
  mediaType: string;
}

export interface EpubSection {
  title: string;
  html: string;
  sourceUrl?: string;
}

interface ChapterMeta {
  id: string;
  file: string;
  title: string;
}

/** Build an EPUB from one or more sections (chapters), content-collector style. */
export async function buildEpub(
  bookTitle: string,
  author: string,
  sections: EpubSection[],
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  const oebps = zip.folder("OEBPS")!;
  oebps.file("style.css", BOOK_CSS);

  const images = new Map<string, ImageRec>();
  const counter = { n: 0 };
  const chapters: ChapterMeta[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const id = `chap${pad(i + 1)}`;
    const file = `${id}.xhtml`;
    const sourceNote = section.sourceUrl
      ? `<p class="source-note">Source: <a href="${escAttr(section.sourceUrl)}">${escXml(section.sourceUrl)}</a></p>`
      : "";
    const dom = new JSDOM(`${section.html}\n${sourceNote}`);
    const doc = dom.window.document;
    stripKindleIncompatible(doc);
    await embedImages(doc, images, oebps, counter);

    const serializer = new dom.window.XMLSerializer();
    let inner = "";
    doc.body.childNodes.forEach((node) => {
      inner += serializer.serializeToString(node);
    });

    oebps.file(
      file,
      `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8"/>
  <title>${escXml(section.title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
<h1>${escXml(section.title)}</h1>
${inner}
</body>
</html>`,
    );
    chapters.push({ id, file, title: section.title });
  }

  const uuid = randomUUID();
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  oebps.file("content.opf", buildOpf(bookTitle, author, uuid, modified, chapters, [...images.values()]));
  oebps.file("nav.xhtml", buildNav(bookTitle, chapters));
  oebps.file("toc.ncx", buildNcx(bookTitle, uuid, chapters));

  return zip.generateAsync({
    type: "nodebuffer",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
  });
}

/**
 * Amazon's Send-to-Kindle converter rejects the whole book (bounce E013)
 * if any chapter contains media/interactive elements, so convert or drop
 * them here — last moment before packaging, previews stay untouched.
 */
function stripKindleIncompatible(doc: Document): void {
  doc.querySelectorAll("video").forEach((video) => {
    const poster = video.getAttribute("poster");
    if (poster) {
      const img = doc.createElement("img");
      img.setAttribute("src", poster);
      video.replaceWith(img);
    } else {
      video.remove();
    }
  });
  doc.querySelectorAll("picture").forEach((picture) => {
    const img = picture.querySelector("img");
    if (img) picture.replaceWith(img);
    else picture.remove();
  });
  doc
    .querySelectorAll("audio, source, canvas, embed, iframe, object, script, svg, form")
    .forEach((el) => el.remove());
  flattenLayoutTables(doc);
  // Amazon's converter crashes (E999) when an attribute value contains '>'
  // and other attributes follow it — even as the legal XHTML entity &gt;;
  // its tokenizer apparently decodes entities before splitting tags.
  // Diagnosed 2026-07-28 from alt="… > Card Image" on an OpenAI article.
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (/[<>]/.test(attr.value)) {
        el.setAttribute(attr.name, attr.value.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim());
      }
    }
  });
}

/**
 * Newsletter bodies are laid out with nested <table> scaffolding, and Amazon's
 * converter rejects a book that contains it (E013) instead of ignoring it.
 * Confirmed 2026-08-18 by sending one Chartbook issue six ways: dropping the
 * images, unwrapping the <figure>s and stripping every data-/aria-/role
 * attribute all still bounced; flattening the tables was the only variant that
 * converted. Nesting depth is not the trigger — La Bonilista nests seven deep
 * and has always gone through — so the rule here is by purpose, not by shape:
 * a table with no <th> and no <caption> of its own is scaffolding, and its
 * cells become blocks, which is what a 6" screen wants anyway. Real data
 * tables are left alone.
 */
function flattenLayoutTables(doc: Document): void {
  const tables = [...doc.querySelectorAll("table")];
  // A <th> inside a nested table says nothing about the table wrapping it, so
  // ownership is decided by the nearest enclosing table, not by descent.
  const layout = new Set(
    tables.filter(
      (t) => ![...t.querySelectorAll("th, caption")].some((el) => el.closest("table") === t),
    ),
  );
  if (layout.size === 0) return;

  const owned = (selector: string) =>
    [...doc.querySelectorAll(selector)].filter((el) => {
      const table = el.closest("table");
      return table !== null && layout.has(table);
    });

  // Cells first, then rows, then the tables themselves: every step above
  // relies on closest("table") still resolving, so the tables go last.
  for (const cell of owned("td")) {
    const div = doc.createElement("div");
    div.append(...[...cell.childNodes]);
    cell.replaceWith(div);
  }
  for (const el of owned("thead, tbody, tfoot, tr, colgroup, col")) {
    el.replaceWith(...[...el.childNodes]);
  }
  for (const table of tables) {
    if (layout.has(table)) table.replaceWith(...[...table.childNodes]);
  }
}

// Precautionary: the largest Kindle screen is 1860×2480, so anything
// bigger only bloats the book and stresses Amazon's converter.
const MAX_EDGE_PX = 1800;

/**
 * Amazon documents JPEG/PNG/GIF/BMP as the supported doc image formats,
 * and progressive-scan JPEG demonstrably bounces the book with E013
 * (2026-07-28, Substack CDN serves fl_progressive:steep). Pass through
 * baseline JPEG/PNG/GIF untouched and re-encode everything else (WebP,
 * SVG, progressive JPEG, oversized) — JPEG if opaque, PNG if it has
 * alpha, downscaled to fit MAX_EDGE_PX. SVG conveniently rasterizes.
 * Returns null for images sharp can't decode; the caller drops those
 * like unfetchable ones.
 */
async function kindleSafeImage(
  buf: Buffer, ct: string,
): Promise<{ buf: Buffer; mediaType: string; ext: string } | null> {
  try {
    const meta = await sharp(buf).metadata();
    const fits = (meta.width ?? Infinity) <= MAX_EDGE_PX && (meta.height ?? Infinity) <= MAX_EDGE_PX;
    if (fits) {
      if (ct === "image/gif") return { buf, mediaType: "image/gif", ext: "gif" };
      if (ct === "image/png") return { buf, mediaType: "image/png", ext: "png" };
      if (ct === "image/jpeg" && !isProgressiveJpeg(buf)) {
        return { buf, mediaType: "image/jpeg", ext: "jpg" };
      }
    }
    const img = sharp(buf).resize({
      width: MAX_EDGE_PX, height: MAX_EDGE_PX,
      fit: "inside", withoutEnlargement: true,
    });
    if (meta.hasAlpha) {
      return { buf: await img.png().toBuffer(), mediaType: "image/png", ext: "png" };
    }
    return {
      buf: await img.jpeg({ quality: 88, progressive: false }).toBuffer(),
      mediaType: "image/jpeg",
      ext: "jpg",
    };
  } catch {
    return null;
  }
}

function isProgressiveJpeg(buf: Buffer): boolean {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return false; // lost marker alignment — assume not
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xc2) return true; // SOF2: progressive DCT
    if (marker === 0xc0 || marker === 0xc1) return false; // baseline/extended
    if (marker === 0xda) return false; // scan data starts, no SOF2 seen
    if (marker >= 0xd0 && marker <= 0xd9) { i += 2; continue; } // bare marker
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return false;
    i += 2 + len;
  }
  return false;
}

const IMAGE_CONCURRENCY = 4;
// Cap on attempts, not just successes: a newsletter full of dead tracker
// images used to cost 20 s apiece, one after another.
const MAX_IMAGE_ATTEMPTS = MAX_IMAGES * 2;

type Fetched = { buf: Buffer; mediaType: string; ext: string } | null;

/** Download with a size cap enforced while streaming, not after buffering. */
async function fetchImage(src: string): Promise<Fetched> {
  try {
    const res = await fetch(src, {
      headers: FETCH_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (!res.ok || !ct.startsWith("image/") || declared > MAX_IMAGE_BYTES || !res.body) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return await kindleSafeImage(Buffer.concat(chunks), ct);
  } catch {
    return null;
  }
}

async function embedImages(
  doc: Document, images: Map<string, ImageRec>, oebps: JSZip, counter: { n: number },
): Promise<void> {
  const imgs = [...doc.querySelectorAll("img")];
  for (const img of imgs) img.removeAttribute("srcset");

  // Fetch each new source once, a few at a time, in document order.
  const pending = [
    ...new Set(
      imgs.map((img) => img.getAttribute("src") ?? "")
        .filter((src) => /^https?:/i.test(src) && !images.has(src)),
    ),
  ].slice(0, MAX_IMAGE_ATTEMPTS);
  const fetched = new Map<string, Fetched>();
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const src = pending[next++];
      fetched.set(src, await fetchImage(src));
    }
  };
  await Promise.all(Array.from({ length: IMAGE_CONCURRENCY }, worker));

  for (const img of imgs) {
    const src = img.getAttribute("src") ?? "";
    let rec = images.get(src);
    const safe = fetched.get(src);
    if (!rec && safe && images.size < MAX_IMAGES) {
      const path = `images/img${pad(++counter.n)}.${safe.ext}`;
      oebps.file(path, safe.buf);
      rec = { path, mediaType: safe.mediaType };
      images.set(src, rec);
    }
    if (rec) img.setAttribute("src", rec.path);
    else img.remove(); // drop images we can't fetch rather than break the book
  }
}

function buildOpf(
  title: string, author: string, uuid: string, modified: string,
  chapters: ChapterMeta[], images: ImageRec[],
): string {
  const chapterItems = chapters
    .map((c) => `    <item id="${c.id}" href="${c.file}" media-type="application/xhtml+xml"/>`)
    .join("\n");
  const imageItems = images
    .map((im, i) => `    <item id="img${pad(i + 1)}" href="${im.path}" media-type="${im.mediaType}"/>`)
    .join("\n");
  const spine = chapters.map((c) => `    <itemref idref="${c.id}"/>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escXml(title)}</dc:title>
    <dc:creator>${escXml(author)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
${chapterItems}
${imageItems}
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>`;
}

function buildNav(title: string, chapters: ChapterMeta[]): string {
  const items = chapters
    .map((c) => `      <li><a href="${c.file}">${escXml(c.title)}</a></li>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>${escXml(title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>`;
}

function buildNcx(title: string, uuid: string, chapters: ChapterMeta[]): string {
  const points = chapters
    .map(
      (c, i) => `    <navPoint id="${c.id}" playOrder="${i + 1}">
      <navLabel><text>${escXml(c.title)}</text></navLabel>
      <content src="${c.file}"/>
    </navPoint>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
    <meta name="dtb:depth" content="1"/>
  </head>
  <docTitle><text>${escXml(title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>`;
}

const pad = (n: number) => String(n).padStart(3, "0");
const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escXml(s).replace(/"/g, "&quot;");
