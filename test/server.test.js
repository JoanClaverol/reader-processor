// Unit tests for the pure helpers, run against the compiled server:
//   pnpm test
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const { noticeFlips } = require("../dist-server/bounces");
const { unwrapTracking } = require("../dist-server/extract");
const { epubFilename } = require("../dist-server/gmail");
const { buildEpub } = require("../dist-server/epub");

test("unwrapTracking follows tracker query params and path segments", () => {
  assert.equal(
    unwrapTracking("https://t.example/c?u=https%3A%2F%2Fnews.example%2Fa"),
    "https://news.example/a",
  );
  assert.equal(
    unwrapTracking("https://tracking.tldrnewsletter.com/CL0/https:%2F%2Fnews.example%2Fa/1/xyz"),
    "https://news.example/a",
  );
});

test("unwrapTracking keeps an article whose attribution param holds a URL", () => {
  const url = "https://blog.example/post?ref=https://x.com/someone&utm_source=https://t.co";
  assert.equal(unwrapTracking(url), url);
});

test("epubFilename keeps accented words and stays ASCII", () => {
  assert.equal(epubFilename("¿Cómo estás?"), "Como estas.epub");
});

test("epubFilename gives distinct non-Latin titles distinct names", () => {
  const a = epubFilename("日本語の記事");
  const b = epubFilename("другая статья");
  assert.match(a, /^article-[0-9a-f]{8}\.epub$/);
  assert.notEqual(a, b);
  assert.equal(epubFilename("日本語の記事"), a); // a resend keeps its name
});

const row = (id, filename, created_at, status = "sent") =>
  ({ id, title: filename, detail: "", status, filename, created_at });

test("noticeFlips flips the earliest unanswered send of the mentioned file", () => {
  const rows = [
    row(1, "Foo.epub", "2026-10-06T08:00:00"),
    row(2, "Foo.epub", "2026-10-06T09:00:00"),
  ];
  const text = "We couldn't deliver Foo.epub due to E013.";
  const { flips, code } = noticeFlips(text, "2026-10-06T10:00:00", rows);
  assert.equal(code, "E013");
  assert.deepEqual(flips.map((r) => r.id), [1]);
});

test("noticeFlips doesn't let a shorter filename claim a longer one's mention", () => {
  const rows = [
    row(1, "Article.epub", "2026-10-06T08:00:00"),
    row(2, "My Great Article.epub", "2026-10-06T08:00:00"),
  ];
  const { flips } = noticeFlips("Problem with My Great Article.epub due to E999", "2026-10-06T09:00:00", rows);
  assert.deepEqual(flips.map((r) => r.id), [2]);
});

test("noticeFlips ignores sends outside the 24h window", () => {
  const rows = [row(1, "Foo.epub", "2026-10-01T08:00:00")];
  const { flips } = noticeFlips("Foo.epub due to E013", "2026-10-06T09:00:00", rows);
  assert.equal(flips.length, 0);
});

async function chapterOf(html) {
  const zip = await JSZip.loadAsync(await buildEpub("T", "a", [{ title: "T", html }]));
  return zip.file("OEBPS/chap001.xhtml").async("string");
}

test("buildEpub flattens layout tables but keeps data tables", async () => {
  const xhtml = await chapterOf(`
    <table><tr><td><p>layout cell</p>
      <table><caption>Prices</caption><tr><th>a</th></tr><tr><td>1</td></tr></table>
    </td></tr></table>`);
  assert.equal((xhtml.match(/<table/g) ?? []).length, 1);
  assert.match(xhtml, /<caption>Prices<\/caption>/);
  assert.match(xhtml, /<div[^>]*><p[^>]*>layout cell<\/p>/);
});

test("buildEpub strips media and '>' inside attribute values", async () => {
  const xhtml = await chapterOf(`<p title="a > b">x</p><iframe src="https://e.x"></iframe><script>1</script>`);
  assert.doesNotMatch(xhtml, /<iframe|<script/);
  assert.match(xhtml, /title="a b"/);
});
