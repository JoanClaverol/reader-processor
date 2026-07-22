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

export async function listNewsletterIds(g: Gmail, label: string, daysBack: number): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await g.users.messages.list({
      userId: "me",
      q: `label:${label} newer_than:${daysBack}d`,
      maxResults: 100,
      pageToken,
    });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
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

export async function sendEpub(g: Gmail, to: string, title: string, epub: Buffer): Promise<void> {
  const filename = (title.replace(/[^\w\s.-]/g, "").trim().slice(0, 80) || "article") + ".epub";
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
