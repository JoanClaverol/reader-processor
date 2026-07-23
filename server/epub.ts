// EPUB builder adapted from content-collector's extension/src/lib/epub.ts:
// JSZip-built EPUB 3 with NCX fallback, book CSS, embedded images. The only
// omission is the canvas-drawn cover (no canvas in Node).
import JSZip from "jszip";
import { JSDOM } from "jsdom";
import { randomUUID } from "crypto";
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
}

async function embedImages(
  doc: Document, images: Map<string, ImageRec>, oebps: JSZip, counter: { n: number },
): Promise<void> {
  const imgs = [...doc.querySelectorAll("img")];
  for (const img of imgs) {
    const src = img.getAttribute("src") ?? "";
    img.removeAttribute("srcset");
    if (!/^https?:/i.test(src)) {
      img.remove();
      continue;
    }
    let rec = images.get(src);
    if (!rec) {
      if (images.size >= MAX_IMAGES) {
        img.remove();
        continue;
      }
      try {
        const res = await fetch(src, {
          headers: FETCH_HEADERS,
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim();
        if (!ct.startsWith("image/") || buf.length > MAX_IMAGE_BYTES) throw new Error("unusable");
        const { ext, mediaType } = imageType(ct, src);
        const path = `images/img${pad(++counter.n)}.${ext}`;
        oebps.file(path, buf);
        rec = { path, mediaType };
        images.set(src, rec);
      } catch {
        img.remove(); // drop images we can't fetch rather than break the book
        continue;
      }
    }
    img.setAttribute("src", rec.path);
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

function imageType(contentType: string, url: string): { ext: string; mediaType: string } {
  const byCt: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/webp": "webp",
  };
  if (contentType && byCt[contentType]) return { ext: byCt[contentType], mediaType: contentType };
  const m = url.split("?")[0].match(/\.(png|jpe?g|gif|svg|webp)$/i);
  const ext = (m ? m[1].toLowerCase() : "jpg").replace("jpeg", "jpg");
  const ctByExt: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", gif: "image/gif",
    svg: "image/svg+xml", webp: "image/webp",
  };
  return { ext, mediaType: ctByExt[ext] ?? "image/jpeg" };
}

const pad = (n: number) => String(n).padStart(3, "0");
const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escXml(s).replace(/"/g, "&quot;");
