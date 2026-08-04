import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { google } from "googleapis";
import { DATA_DIR } from "./config";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export const CREDENTIALS_PATH = path.join(DATA_DIR, "credentials.json");
export const TOKEN_PATH = path.join(DATA_DIR, "token.json");
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

export function makeOAuthClient(redirectUri?: string): OAuth2Client {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Missing ${CREDENTIALS_PATH}. Download an OAuth client (Desktop app) credential from Google Cloud Console.`,
    );
  }
  const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")).installed;
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);
}

/** Auth from the saved token — compatible with the token the Python app saved. */
export function getAuth(): OAuth2Client {
  if (!existsSync(TOKEN_PATH)) {
    throw new Error("Not authenticated with Gmail. Run:  reader-process auth");
  }
  const token = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
  const client = makeOAuthClient();
  client.setCredentials({
    refresh_token: token.refresh_token,
    access_token: token.access_token ?? token.token,
  });
  return client;
}

export type Gmail = ReturnType<typeof google.gmail>;

export function gmailClient(): Gmail {
  return google.gmail({ version: "v1", auth: getAuth() });
}

export async function searchMessageIds(g: Gmail, q: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await g.users.messages.list({
      userId: "me",
      q,
      maxResults: 100,
      pageToken,
    });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

export function listNewsletterIds(g: Gmail, label: string, daysBack: number): Promise<string[]> {
  return searchMessageIds(g, `label:${label} newer_than:${daysBack}d`);
}

function collectParts(part: any, mime: string, out: string[]): void {
  if (part?.mimeType === mime && part?.body?.data) {
    out.push(Buffer.from(part.body.data, "base64url").toString("utf8"));
  }
  for (const p of part?.parts ?? []) collectParts(p, mime, out);
}

export async function fetchMessage(g: Gmail, msgId: string) {
  const res = await g.users.messages.get({ userId: "me", id: msgId, format: "full" });
  const payload: any = res.data.payload ?? {};
  const headers: Record<string, string> = {};
  for (const h of payload.headers ?? []) headers[String(h.name).toLowerCase()] = String(h.value);

  const htmlParts: string[] = [];
  collectParts(payload, "text/html", htmlParts);
  let html = htmlParts.sort((a, b) => b.length - a.length)[0] ?? "";
  if (!html) {
    const textParts: string[] = [];
    collectParts(payload, "text/plain", textParts);
    const joined = textParts.join("\n");
    html = joined ? `<pre>${joined.replace(/</g, "&lt;")}</pre>` : "";
  }
  let dateIso = "";
  const parsed = new Date(headers["date"] ?? "");
  if (!isNaN(parsed.getTime())) dateIso = parsed.toISOString().slice(0, 19);

  return {
    id: msgId,
    sender: headers["from"] ?? "unknown",
    subject: headers["subject"] ?? "(no subject)",
    date_iso: dateIso,
    html,
  };
}

function encodeSubject(subject: string): string {
  return /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function epubFilename(title: string): string {
  // Decompose first so accents become ASCII letters plus combining marks, and
  // drop the marks: "¿Cómo estás?" keeps its words as "Como estas" instead of
  // being gutted to "Cmo ests". Stays pure ASCII, so the filename needs no
  // RFC 2231 encoding in the MIME headers below — Amazon is unforgiving there.
  const ascii = title
    .normalize("NFKD").replace(/\p{M}/gu, "")
    // Trim again after slicing: an 80-char cut can land just past a space.
    .replace(/[^\w\s.-]/g, "").trim().slice(0, 80).trim();
  if (ascii) return ascii + ".epub";
  // Scripts that don't reduce to ASCII at all (Japanese, Cyrillic, Greek) used
  // to collapse to a single shared "article.epub". Bounce notices are matched
  // to sends by filename, so identical names made checkBounces flip the wrong
  // row — marking a delivered article as bounced and leaving the real failure
  // showing as sent. Derive the suffix from the title so distinct articles get
  // distinct names, while a resend of the same title keeps the one filename
  // rowsToFlip already expects.
  const digest = createHash("sha1").update(title).digest("hex").slice(0, 8);
  return `article-${digest}.epub`;
}

/** Sends the book and returns the attachment filename it went out under. */
export async function sendEpub(g: Gmail, to: string, title: string, epub: Buffer): Promise<string> {
  // Scraped titles can carry newlines; raw CR/LF here would be spliced into
  // the MIME headers below, truncating the attachment filename mid-header
  // (Kindle then bounces E001) and opening header injection.
  title = title.replace(/\s+/g, " ").trim();
  const filename = epubFilename(title);
  const boundary = "reader-processor-boundary";
  const b64 = epub.toString("base64").replace(/(.{76})/g, "$1\r\n");
  const mime = [
    `To: ${to}`,
    "From: me",
    `Subject: ${encodeSubject(title.slice(0, 150))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Sent by reader-processor.",
    "",
    `--${boundary}`,
    `Content-Type: application/epub+zip; name="${filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    b64,
    `--${boundary}--`,
  ].join("\r\n");
  await g.users.messages.send({
    userId: "me",
    requestBody: { raw: Buffer.from(mime, "utf8").toString("base64url") },
  });
  return filename;
}

export async function ensureLabel(g: Gmail, name: string): Promise<string> {
  const res = await g.users.labels.list({ userId: "me" });
  for (const lb of res.data.labels ?? []) {
    if (lb.name?.toLowerCase() === name.toLowerCase() && lb.id) return lb.id;
  }
  const created = await g.users.labels.create({ userId: "me", requestBody: { name } });
  return created.data.id!;
}

export async function addLabel(g: Gmail, msgId: string, labelId: string): Promise<void> {
  await g.users.messages.modify({
    userId: "me",
    id: msgId,
    requestBody: { addLabelIds: [labelId] },
  });
}
