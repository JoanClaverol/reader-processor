import Database from "better-sqlite3";
import { chmodSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { DATA_DIR } from "./config";

const DB_PATH = path.join(DATA_DIR, "reader-processor.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sender TEXT, subject TEXT, date_iso TEXT, html TEXT,
    fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS articles (
    url TEXT PRIMARY KEY,
    final_url TEXT, title TEXT, html TEXT,
    fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    url TEXT,
    title TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    filename TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bounces (
    msg_id TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL
);
`;

export interface CachedMessage {
  id: string;
  sender: string;
  subject: string;
  date_iso: string;
  html: string;
}

let db: Database.Database | null = null;

function conn(): Database.Database {
  if (!db) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    db = new Database(DB_PATH);
    db.exec(SCHEMA);
    try {
      db.exec("ALTER TABLE articles ADD COLUMN word_count INTEGER");
    } catch {
      /* column already exists */
    }
    try {
      db.exec("ALTER TABLE sent ADD COLUMN filename TEXT");
    } catch {
      /* column already exists */
    }
    restrictPermissions();
    pruneCaches(db);
  }
  return db;
}

/**
 * The db holds email bodies and data/ holds the OAuth client and token, but
 * mkdirSync's mode only applies when it creates the directory — a data/ left
 * by an older checkout stayed world-readable. Tighten on every start.
 */
function restrictPermissions(): void {
  const tighten = (p: string, mode: number) => {
    try {
      chmodSync(p, mode);
    } catch {
      /* missing file, or not ours to change */
    }
  };
  tighten(DATA_DIR, 0o700);
  for (const name of readdirSync(DATA_DIR)) tighten(path.join(DATA_DIR, name), 0o600);
}

// Both caches only ever serve the last `days_back` of mail; anything older
// is dead weight (the db had grown past 40 MB). The send log is kept.
const CACHE_TTL_DAYS = 60;

function pruneCaches(conn: Database.Database): void {
  const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 86_400_000).toISOString().slice(0, 19);
  const gone =
    conn.prepare("DELETE FROM messages WHERE fetched_at < ?").run(cutoff).changes +
    conn.prepare("DELETE FROM articles WHERE fetched_at < ?").run(cutoff).changes;
  if (gone > 0) conn.exec("VACUUM");
}

const now = () => new Date().toISOString().slice(0, 19);

export function getCachedMessages(ids: string[]): Map<string, CachedMessage> {
  const map = new Map<string, CachedMessage>();
  if (ids.length === 0) return map;
  const marks = ids.map(() => "?").join(",");
  const rows = conn()
    .prepare(`SELECT * FROM messages WHERE id IN (${marks})`)
    .all(...ids) as CachedMessage[];
  for (const r of rows) map.set(r.id, r);
  return map;
}

export function cacheMessage(msg: CachedMessage): void {
  conn()
    .prepare(
      "INSERT OR REPLACE INTO messages (id, sender, subject, date_iso, html, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(msg.id, msg.sender, msg.subject, msg.date_iso, msg.html, now());
}

export function getArticle(url: string): { final_url: string; title: string; html: string } | null {
  const row = conn().prepare("SELECT * FROM articles WHERE url = ?").get(url) as
    | { final_url: string; title: string; html: string }
    | undefined;
  return row ?? null;
}

export function putArticle(
  url: string, finalUrl: string, title: string, html: string, wordCount: number,
): void {
  conn()
    .prepare(
      "INSERT OR REPLACE INTO articles (url, final_url, title, html, fetched_at, word_count) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(url, finalUrl, title, html, now(), wordCount);
}

/** word_count for every cached article, keyed by request URL. */
export function articleWordCounts(): Map<string, number> {
  const map = new Map<string, number>();
  const rows = conn()
    .prepare("SELECT url, word_count FROM articles WHERE word_count IS NOT NULL")
    .all() as { url: string; word_count: number }[];
  for (const r of rows) map.set(r.url, r.word_count);
  return map;
}

export function recordSent(
  messageId: string, kind: string, url: string | null, title: string,
  status: string, detail = "", filename: string | null = null,
): void {
  conn()
    .prepare(
      "INSERT INTO sent (message_id, kind, url, title, status, detail, filename, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(messageId, kind, url, title, status, detail, filename, now());
}

export interface SentRow {
  id: number;
  title: string | null;
  detail: string | null;
  status: string;
  filename: string | null;
  created_at: string;
}

/** Every log row that went out as an attachment, oldest first. */
export function sentRowsWithFilename(): SentRow[] {
  return conn()
    .prepare(
      "SELECT id, title, detail, status, filename, created_at FROM sent WHERE filename IS NOT NULL ORDER BY id ASC",
    )
    .all() as SentRow[];
}

export function updateSentStatus(id: number, status: string, detail: string): void {
  conn().prepare("UPDATE sent SET status = ?, detail = ? WHERE id = ?").run(status, detail, id);
}

export function isBounceProcessed(msgId: string): boolean {
  return !!conn().prepare("SELECT 1 FROM bounces WHERE msg_id = ?").get(msgId);
}

export function markBounceProcessed(msgId: string): void {
  conn()
    .prepare("INSERT OR IGNORE INTO bounces (msg_id, processed_at) VALUES (?, ?)")
    .run(msgId, now());
}

export function sentKeys(): Set<string> {
  const keys = new Set<string>();
  const rows = conn()
    .prepare("SELECT message_id, kind, url FROM sent WHERE status='sent'")
    .all() as { message_id: string; kind: string; url: string | null }[];
  for (const r of rows) {
    keys.add(r.kind === "body" ? `body:${r.message_id}` : `link:${r.url}`);
  }
  return keys;
}

export function recentLog(limit = 100): unknown[] {
  return conn().prepare("SELECT * FROM sent ORDER BY id DESC LIMIT ?").all(limit);
}
