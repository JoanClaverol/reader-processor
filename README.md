# reader-processor

A local replacement for Readwise Reader's send-to-Kindle flow. It reads your
Gmail `newsletter`-labeled emails, shows them in a localhost dashboard with
their article links extracted, and sends what you pick to your Kindle as clean
EPUBs — full newsletter bodies or the web articles behind digest links.

Everything runs on your machine. Your Gmail token never leaves it: you
authenticate with your **own** Google OAuth credential, and the dashboard only
answers requests from localhost. No server, no domain, no forwarding rules.

## Install

Requires [Node.js](https://nodejs.org) ≥ 20 and [pnpm](https://pnpm.io).

```sh
git clone https://github.com/JoanClaverol/reader-processor.git
cd reader-processor
pnpm install         # also builds the TypeScript
pnpm add --global ./ # puts `reader-process` on your PATH (linked to this checkout)
```

## One-time setup

1. **Config**: create `~/.reader-processor/config.toml` from
   [`config.toml.example`](config.toml.example) and set `kindle_email`.
   (A `config.toml` in the repo root also works if you prefer to keep
   everything in the checkout.)

2. **Amazon**: in [Manage Your Content and Devices → Preferences → Personal
   Document Settings](https://www.amazon.com/hz/mycd/myx#/home/settings/payment),
   add your Gmail address to the **Approved Personal Document E-mail List**,
   and note your `@kindle.com` address.

3. **Google OAuth credential** (lets the app read/send with your Gmail — it's
   yours alone, so no third party ever sees your mail):
   - Go to [Google Cloud Console](https://console.cloud.google.com/), create a
     project (e.g. `reader-processor`).
   - APIs & Services → Library → enable the **Gmail API**.
   - APIs & Services → OAuth consent screen → External, add yourself as a test
     user.
   - APIs & Services → Credentials → Create credentials → **OAuth client ID** →
     Application type **Desktop app**.
   - Download the JSON and save it as `~/.reader-processor/data/credentials.json`.

4. **Authenticate** (opens a browser once):

   ```sh
   reader-process auth
   ```

5. **Gmail label**: the app lists emails carrying the `newsletter` label
   (configurable as `source_label`). Set up a Gmail filter that applies it to
   your newsletter subscriptions.

## Run

```sh
reader-process
```

It picks the first free port from 8377 up, starts the server, and opens the
dashboard in your browser (set `NO_OPEN=1` to skip the auto-open).

Tick the newsletters/links you want, hit send.
Sent items are marked ✓, the source email gets a `kindle-sent` label in Gmail,
and `/log` shows the send history (stored in the `data/` SQLite db).

The UI is two panes: newsletters on the left, a preview of the selected
content on the right. Click a newsletter to preview its body; click a link to
fetch and preview the article behind it. Tick checkboxes and send in batch.

## Where things live

State is kept in `~/.reader-processor/` by default (or the repo root if a
`config.toml` / `data/` already exists there; override with
`$READER_PROCESSOR_HOME`):

- `config.toml` — your settings.
- `data/credentials.json` — your Google OAuth client (you created it).
- `data/token.json` — your Gmail token (owner-only file permissions).
- `data/reader-processor.db` — message/article cache and send log.

None of these are ever committed: `data/` and `config.toml` are gitignored.

## How it works

The app is TypeScript: a Node/Express backend (`server/`) and a vanilla TS
frontend (`frontend/`), built together by `pnpm run build` (which
`pnpm install` runs automatically).

- `server/index.ts` — Express JSON API + serves the static frontend. Binds
  `127.0.0.1` only and rejects non-local `Host`/`Origin` headers, so neither
  your LAN nor other websites can reach it.
- `server/gmail.ts` — Gmail API (googleapis): list/read labeled emails, send
  EPUB attachments from your own account, manage the sent label.
- `server/extract.ts` — parses newsletter HTML: pulls candidate article links
  (unwrapping tracking redirects, flagging unsubscribe/social/sponsor junk),
  light-touch body cleanup (tracking pixels, scripts, hidden elements) that
  keeps the newsletter's own layout.
- `server/fetchArticle.ts` — fetches a linked article (http/https only) and
  extracts readable content (@mozilla/readability).
- `server/epub.ts` — EPUB builder (JSZip, book CSS, embedded images).
- `server/store.ts` — SQLite (better-sqlite3): message cache + fetched-article
  cache + send log.
- `frontend/main.ts` — the dashboard UI, compiled to `public/main.js`.
- `bin/reader-process.js` — the CLI launcher (`reader-process`,
  `reader-process auth`).

## Notes

- Message bodies are cached in SQLite, so only new newsletters hit the Gmail
  API on page load.
- If an article fails to extract (paywall, JS-only page), the result page shows
  the error and nothing is sent for that item.
- Junk-link filtering lives in `JUNK_TEXT` / `JUNK_HOSTS` in
  `server/extract.ts` — tune per your newsletters.
- To update: `git pull && pnpm install`.
- To uninstall the global command: `pnpm remove --global reader-processor`.
