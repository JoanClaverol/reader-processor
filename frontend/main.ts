// reader-processor frontend: emails | items | paper preview, with keyboard triage.

interface Link {
  url: string; title: string; minutes: number | null; domain: string;
  junk: boolean; sent: boolean;
}
interface Newsletter {
  id: string; sender_display: string; subject: string; date_iso: string;
  body_sent: boolean; minutes: number | null; links: Link[];
}
// `warning` marks bookkeeping that failed after the book was already sent
// (e.g. the Gmail label) — it must never be counted as a failed delivery.
interface SendResult { title: string; ok: boolean; detail: string; warning?: boolean }

type SelItem = { kind: "body" | "link"; msg_id: string; url?: string; title: string };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const emailList = $("email-list");
const itemsPane = $("items");
const previewFrame = $<HTMLIFrameElement>("preview");
const previewStatus = $("preview-status");
const previewStatusText = $("preview-status-text");
const previewSpinner = previewStatus.querySelector(".spinner") as HTMLElement;
const previewTitle = $("preview-title");
const sendThisBtn = $<HTMLButtonElement>("send-this");
const sendBtn = $<HTMLButtonElement>("send-btn");
const sendCount = $("send-count");
const modal = $<HTMLDialogElement>("modal");
const modalContent = $("modal-content");

let newsletters: Newsletter[] = [];
let activeId: string | null = null;
let awaitingAuthentication = false;
const viewed = new Set<string>(
  JSON.parse(localStorage.getItem("viewedEmails") ?? "[]") as string[],
);

function markViewed(id: string): void {
  viewed.add(id);
  // Keep only ids still in the visible window so the list never grows unbounded.
  const current = new Set(newsletters.map((n) => n.id));
  localStorage.setItem(
    "viewedEmails",
    JSON.stringify([...viewed].filter((v) => current.has(v))),
  );
}
let showHidden = false;
let currentPreview: SelItem | null = null;
const selected = new Map<string, SelItem>();

// Display orders, rebuilt on render — the keyboard navigates these.
let emailOrder: Newsletter[] = [];
let itemOrder: SelItem[] = [];
let focusPane: "emails" | "items" = "emails";
let emailFocusIdx = -1;
let itemFocusIdx = -1;

const selKey = (kind: string, msgId: string, url?: string) =>
  kind === "body" ? `body:${msgId}` : `link:${msgId}:${url}`;
const isProcessed = (nl: Newsletter) => nl.body_sent || nl.links.some((l) => l.sent);

// Quotes included: newsletter-controlled titles and URLs reach attribute
// values (the paste dialog), where escaping only < and > lets a crafted link
// break out of the value and run script in the dashboard's own origin.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Read a JSON response, tolerating the HTML error pages Express emits for an
 * oversized body or an unhandled throw. Without this the user is shown
 * "Unexpected token '<'" instead of what actually went wrong.
 */
async function readJson(resp: Response): Promise<Record<string, any>> {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: resp.status === 413
        ? "that paste is too large (over 8 MB) — try selecting less of the page"
        : `server error (HTTP ${resp.status})`,
    };
  }
}

// The server stores UTC timestamps without a zone suffix ("2026-10-05T23:30:00"),
// which Date would otherwise parse as local time — shifting every card by the
// UTC offset and filing late-night mail under the wrong day.
function parseUtc(iso: string): Date {
  return new Date(/Z|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z");
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const localTime = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const localDateTime = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${localTime(d)}`;

function updateSendBtn(): void {
  sendCount.textContent = String(selected.size);
  sendBtn.disabled = selected.size === 0;
}

// ---------- email list (left column) ----------

function dayLabel(iso: string): string {
  if (!iso) return "Unknown date";
  const d = parseUtc(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function loadNewsletters(): Promise<void> {
  const resp = await fetch("/api/newsletters");
  const data = await resp.json();
  if (!resp.ok) {
    emailList.innerHTML = "";
    const box = document.createElement("div");
    box.className = "error-box";
    if (data.code === "gmail_auth_required") {
      const title = document.createElement("strong");
      title.textContent = "Connect Gmail to continue";
      const detail = document.createElement("p");
      detail.textContent = "Reader Processor needs permission to read your newsletters and send books.";
      const button = document.createElement("button");
      button.textContent = "Sign in with Google";
      button.addEventListener("click", () => {
        awaitingAuthentication = true;
        window.location.href = "reader-processor://authenticate";
      });
      box.append(title, detail, button);
    } else {
      box.textContent = `Setup needed: ${data.error}`;
    }
    emailList.appendChild(box);
    return;
  }
  awaitingAuthentication = false;
  newsletters = data.newsletters;
  sendBtn.title = `Deliver to ${data.kindle_email}`;
  renderEmailList();
  const active = newsletters.find((n) => n.id === activeId);
  if (active) renderItems(active);
}

function renderEmailList(): void {
  const fresh = newsletters.filter((n) => !isProcessed(n));
  const processed = newsletters.filter(isProcessed);
  emailOrder = [...fresh, ...processed];
  emailList.innerHTML = "";

  if (newsletters.length === 0) {
    const div = document.createElement("div");
    div.className = "placeholder";
    div.textContent = "No newsletters in the configured window.";
    emailList.appendChild(div);
    return;
  }

  let lastGroup = "";
  for (const nl of fresh) {
    const group = dayLabel(nl.date_iso);
    if (group !== lastGroup) {
      emailList.appendChild(groupHeader(group));
      lastGroup = group;
    }
    emailList.appendChild(emailCard(nl));
  }
  if (processed.length > 0) {
    emailList.appendChild(groupHeader("Processed"));
    for (const nl of processed) emailList.appendChild(emailCard(nl));
  }
  refreshKbdFocus();
}

function groupHeader(label: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "day-header";
  h.textContent = label;
  return h;
}

function emailCard(nl: Newsletter): HTMLElement {
  const card = document.createElement("div");
  card.className = "email-card"
    + (nl.id === activeId ? " active" : "")
    + (isProcessed(nl) ? " processed" : "")
    + (viewed.has(nl.id) ? " viewed" : "");
  card.dataset.emailId = nl.id;
  const sentCount = nl.links.filter((l) => l.sent).length + (nl.body_sent ? 1 : 0);
  const linkCount = nl.links.filter((l) => !l.junk).length;
  const time = nl.date_iso ? localTime(parseUtc(nl.date_iso)) : "";
  const unread = !viewed.has(nl.id) && !isProcessed(nl);
  card.innerHTML = `
    <div class="sender">${unread ? '<span class="unread-dot"></span>' : ""}<span class="sender-name"></span></div>
    <div class="subject"></div>
    <div class="meta"><span>${time}</span><span>${linkCount} links</span>
      ${sentCount ? `<span class="sent-mark">✓ ${sentCount} sent</span>` : ""}</div>`;
  (card.querySelector(".sender-name") as HTMLElement).textContent = nl.sender_display;
  (card.querySelector(".subject") as HTMLElement).textContent = nl.subject;
  card.addEventListener("click", () => activateEmail(nl));
  return card;
}

function activateEmail(nl: Newsletter): void {
  activeId = nl.id;
  markViewed(nl.id);
  emailFocusIdx = emailOrder.findIndex((n) => n.id === nl.id);
  renderEmailList();
  renderItems(nl);
  previewItem({ kind: "body", msg_id: nl.id, title: nl.subject });
  prefetchArticles(nl);
}

// Warm the server-side article cache for the selected newsletter so clicking
// a link previews instantly instead of waiting on a live fetch.
const prefetched = new Set<string>();

function prefetchArticles(nl: Newsletter): void {
  const urls = nl.links
    .filter((l) => !l.junk && !l.sent && !prefetched.has(l.url))
    .map((l) => l.url);
  let i = 0;
  const next = (): void => {
    if (i >= urls.length) return;
    const url = urls[i++];
    prefetched.add(url);
    fetch(`/api/preview/article?url=${encodeURIComponent(url)}`)
      .catch(() => {})
      .finally(next);
  };
  for (let k = 0; k < 3; k++) next(); // 3 fetches in flight at a time
}

// ---------- items (middle column) ----------

function renderItems(nl: Newsletter): void {
  itemsPane.innerHTML = "";
  itemOrder = [];
  itemFocusIdx = -1;

  const bodyItem: SelItem = { kind: "body", msg_id: nl.id, title: nl.subject };
  itemOrder.push(bodyItem);
  const bodyMeta = [`full newsletter`, nl.sender_display, nl.minutes ? `~${nl.minutes} min` : ""]
    .filter(Boolean).join(" · ");
  itemsPane.appendChild(itemRow(bodyItem, {
    metaText: bodyMeta, sent: nl.body_sent, junk: false,
  }));

  const visible = nl.links.filter((l) => !l.junk);
  const hidden = nl.links.filter((l) => l.junk);
  const shown = showHidden ? [...visible, ...hidden] : visible;

  for (const link of shown) {
    const item: SelItem = { kind: "link", msg_id: nl.id, url: link.url, title: link.title };
    itemOrder.push(item);
    const meta = [link.domain, link.minutes ? `${link.minutes} min` : ""]
      .filter(Boolean).join(" · ");
    itemsPane.appendChild(itemRow(item, { metaText: meta, sent: link.sent, junk: link.junk }));
  }

  if (hidden.length > 0) {
    const toggle = document.createElement("button");
    toggle.id = "hidden-toggle";
    toggle.textContent = showHidden
      ? `Hide ${hidden.length} filtered links`
      : `${hidden.length} links hidden — show`;
    toggle.addEventListener("click", () => {
      showHidden = !showHidden;
      renderItems(nl);
    });
    itemsPane.appendChild(toggle);
  }
  refreshKbdFocus();
}

function itemRow(
  item: SelItem,
  opts: { metaText: string; sent: boolean; junk: boolean },
): HTMLElement {
  const key = selKey(item.kind, item.msg_id, item.url);
  const row = document.createElement("div");
  row.className = `item-row ${item.kind === "body" ? "body-row" : ""}${opts.junk ? " junk" : ""}`;
  row.dataset.key = key;
  if (currentPreview && selKey(currentPreview.kind, currentPreview.msg_id, currentPreview.url) === key) {
    row.classList.add("previewing");
  }

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = selected.has(key);
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => {
    if (cb.checked) selected.set(key, item);
    else selected.delete(key);
    updateSendBtn();
  });

  const main = document.createElement("div");
  main.className = "item-main";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = item.title;
  title.title = item.url ?? item.title;
  const meta = document.createElement("div");
  meta.className = "item-meta";
  meta.textContent = opts.metaText;
  if (opts.sent) {
    const mark = document.createElement("span");
    mark.className = "sent-mark";
    mark.textContent = "✓ sent";
    meta.appendChild(mark);
  }
  main.appendChild(title);
  main.appendChild(meta);

  row.appendChild(cb);
  row.appendChild(main);
  row.addEventListener("click", () => {
    itemFocusIdx = itemOrder.findIndex(
      (i) => selKey(i.kind, i.msg_id, i.url) === key);
    focusPane = "items";
    previewItem(item);
  });
  return row;
}

function markPreviewing(): void {
  const key = currentPreview
    ? selKey(currentPreview.kind, currentPreview.msg_id, currentPreview.url) : "";
  itemsPane.querySelectorAll(".item-row").forEach((r) =>
    r.classList.toggle("previewing", (r as HTMLElement).dataset.key === key));
}

// ---------- preview (right column) ----------

// Dark reading mode: invert the iframe document's luminance (hue-rotate keeps
// colors roughly natural); images get a second inversion to look normal.
const darkToggle = $<HTMLButtonElement>("dark-toggle");
let darkReading = localStorage.getItem("darkReading") === "1";

function renderDarkToggle(): void {
  darkToggle.classList.toggle("active", darkReading);
  darkToggle.setAttribute("aria-pressed", String(darkReading));
}

function toggleDarkReading(): void {
  darkReading = !darkReading;
  localStorage.setItem("darkReading", darkReading ? "1" : "0");
  renderDarkToggle();
  if (currentPreview) previewItem(currentPreview); // re-wrap current content
}

darkToggle.addEventListener("click", toggleDarkReading);
renderDarkToggle();

// Set by a dialog holding unsaved input; returns false to veto the close.
// Every close path routes through tryCloseModal (or the "cancel" handler for
// Esc), so a read-only dialog just leaves this null.
let closeGuard: (() => boolean) | null = null;

function tryCloseModal(): void {
  if (closeGuard && !closeGuard()) return;
  closeGuard = null;
  modal.close();
}

let previewToken = 0;

// An action button lives beside the status text only while that status is up.
let statusAction: HTMLButtonElement | null = null;

function showPreviewStatus(
  text: string, loading = true, action?: { label: string; run: () => void },
): void {
  previewStatusText.textContent = text;
  previewSpinner.classList.toggle("hidden", !loading);
  statusAction?.remove();
  statusAction = null;
  if (action) {
    statusAction = document.createElement("button");
    statusAction.className = "ghost-accent";
    statusAction.textContent = action.label;
    statusAction.addEventListener("click", action.run);
    previewStatus.appendChild(statusAction);
  }
  previewStatus.classList.remove("hidden");
  previewFrame.classList.add("loading");
}

function showPreviewHtml(title: string, html: string): void {
  previewFrame.srcdoc = `<!doctype html><html${darkReading ? ' class="dark"' : ""}><head><meta charset="utf-8">
    <style>body{font-family:Georgia,serif;max-width:640px;margin:1.5rem auto;padding:0 1.2rem 3rem;
    line-height:1.55;color:#111;background:#fff} img{max-width:100%;height:auto}
    a{color:#2563eb}
    html.dark{filter:invert(1) hue-rotate(180deg);background:#fff}
    html.dark img,html.dark video{filter:invert(1) hue-rotate(180deg)}</style>
    </head><body>${html}</body></html>`;
  statusAction?.remove();
  statusAction = null;
  previewStatus.classList.add("hidden");
  previewFrame.classList.remove("loading");
}

/**
 * Bot-walled sites only open in a real browser, so let the user paste what they
 * see there. A contenteditable rather than a textarea, because the clipboard
 * carries HTML: paragraphs, links and images survive the trip.
 */
function openPasteDialog(item: SelItem): void {
  modalContent.innerHTML = `<h3>Paste article</h3>
    <p class="paste-hint">Open
      <a href="${escapeHtml(item.url!)}" target="_blank" rel="noreferrer noopener">the article</a>
      in your browser, select all of it (⌘A) and paste it below (⌘V).</p>
    <input id="paste-title" type="text" placeholder="Title" value="${escapeHtml(item.title)}">
    <div id="paste-body" contenteditable="true" role="textbox" aria-label="Article content"></div>
    <div class="paste-actions">
      <span id="paste-error" class="fail"></span>
      <button id="paste-save">Save article</button>
    </div>`;

  // Resolved once, up front: re-querying after the await would hit whatever
  // replaced the dialog's contents in the meantime.
  const bodyEl = $("paste-body");
  const titleEl = $<HTMLInputElement>("paste-title");
  const errorEl = $("paste-error");
  const saveBtn = $<HTMLButtonElement>("paste-save");
  let saved = false;

  // This is the app's only data-entry surface, and the dialog is deliberately
  // easy to dismiss — don't let a stray Esc bin a long manual paste.
  closeGuard = () =>
    saved || !bodyEl.textContent?.trim() || confirm("Discard the article you pasted?");

  modal.showModal();
  bodyEl.focus();

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    errorEl.textContent = "";
    try {
      const resp = await fetch("/api/article/paste", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: item.url,
          title: titleEl.value,
          html: bodyEl.innerHTML,
        }),
      });
      const data = await readJson(resp);
      if (!resp.ok) throw new Error(data.error ?? "server error");
      saved = true;
      tryCloseModal();
      previewItem({ ...item, title: data.title }); // now served from the cache
    } catch (e) {
      errorEl.textContent = String((e as Error).message ?? e);
      saveBtn.disabled = false;
    }
  });
}

async function previewItem(item: SelItem): Promise<void> {
  const token = ++previewToken;
  currentPreview = item;
  previewTitle.textContent = item.title;
  sendThisBtn.disabled = false;
  markPreviewing();

  if (item.kind === "body") {
    showPreviewStatus("Loading newsletter…");
    let data: { title?: string; html?: string; error?: string };
    let ok: boolean;
    try {
      const resp = await fetch(`/api/preview/body/${item.msg_id}`);
      ok = resp.ok;
      data = await resp.json();
    } catch (e) {
      ok = false;
      data = { error: String(e) };
    }
    if (token !== previewToken) return; // a newer preview superseded this one
    if (!ok || data.html === undefined) {
      showPreviewStatus(`⚠️ Could not render this newsletter: ${data.error ?? "server error"}`, false);
      return;
    }
    showPreviewHtml(data.title ?? item.title, data.html);
  } else {
    showPreviewStatus("Fetching article…");
    let data: { title?: string; html?: string; error?: string; pasteable?: boolean };
    let ok: boolean;
    try {
      const resp = await fetch(`/api/preview/article?url=${encodeURIComponent(item.url!)}`);
      ok = resp.ok;
      data = await readJson(resp);
    } catch (e) {
      // A dropped connection must not leave the pane stuck on "Fetching…".
      ok = false;
      data = { error: String((e as Error).message ?? e) };
    }
    if (token !== previewToken) return;
    if (!ok || data.html === undefined) {
      showPreviewStatus(
        `⚠️ Could not extract this article: ${data.error ?? "server error"}`, false,
        data.pasteable ? { label: "Paste article…", run: () => openPasteDialog(item) } : undefined,
      );
      return;
    }
    const title = data.title ?? item.title;
    showPreviewHtml(title, `<h2>${escapeHtml(title)}</h2>${data.html}`);
  }
}

// ---------- sending ----------

const bundleCb = $<HTMLInputElement>("bundle-cb");
bundleCb.checked = localStorage.getItem("bundleMode") === "1";
bundleCb.addEventListener("change", () =>
  localStorage.setItem("bundleMode", bundleCb.checked ? "1" : "0"));

const sendProgress = $("send-progress");
const sendProgressFill = $("send-progress-fill");

function progressStart(indeterminate: boolean): void {
  sendProgress.classList.remove("hidden");
  sendProgress.classList.toggle("indeterminate", indeterminate);
  sendProgressFill.style.width = indeterminate ? "" : "0%";
}
function progressSet(done: number, total: number): void {
  sendProgressFill.style.width = `${(done / total) * 100}%`;
}
function progressEnd(): void {
  sendProgress.classList.add("hidden");
  sendProgress.classList.remove("indeterminate");
  sendProgressFill.style.width = "0%";
}

async function postSend(items: SelItem[], bundle: boolean): Promise<SendResult[]> {
  const resp = await fetch("/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: items.map(({ kind, msg_id, url }) => ({ kind, msg_id, url })),
      bundle,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error ?? "server error");
  return data.results as SendResult[];
}

async function sendItems(items: SelItem[]): Promise<void> {
  if (items.length === 0) return;
  sendBtn.disabled = true;
  sendThisBtn.disabled = true;

  const bundled = bundleCb.checked && items.length > 1;
  const results: SendResult[] = [];
  progressStart(bundled);
  sendCount.textContent = bundled ? "…" : `0/${items.length}`;
  try {
    if (bundled) {
      // One book = one request; nothing granular to report until it lands.
      try {
        results.push(...await postSend(items, true));
      } catch (e) {
        results.push({ title: "Bundled digest", ok: false, detail: String(e) });
      }
    } else {
      // Sequential per-item sends — same emails the server would send for a
      // batch, but each completed item can advance the progress bar.
      let done = 0;
      for (const item of items) {
        try {
          results.push(...await postSend([item], false));
        } catch (e) {
          results.push({ title: item.title, ok: false, detail: String(e) });
        }
        done++;
        progressSet(done, items.length);
        sendCount.textContent = `${done}/${items.length}`;
      }
    }
  } finally {
    progressEnd();
  }

  showSendToast(results);
  for (const item of items) selected.delete(selKey(item.kind, item.msg_id, item.url));
  await loadNewsletters();
  updateSendBtn();
  sendThisBtn.disabled = currentPreview === null;
}

function showSendToast(results: SendResult[]): void {
  const fails = results.filter((r) => !r.ok && !r.warning);
  const warnings = results.filter((r) => r.warning);
  const okCount = results.filter((r) => r.ok).length;
  const allOk = fails.length === 0;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `
    <div class="toast-title"><span class="${allOk ? "ok" : "fail"}">${allOk ? "✓" : "✗"}</span>
      <span>${allOk
        ? `${okCount} item${okCount === 1 ? "" : "s"} sent to Kindle`
        : `${okCount} sent · ${fails.length} failed`}</span></div>
    ${allOk ? "" : `<ul class="toast-fails">${fails.map((f) => `<li>${escapeHtml(f.title)}</li>`).join("")}</ul>`}
    ${warnings.map((w) => `<div class="toast-warn">⚠️ ${escapeHtml(w.detail)}</div>`).join("")}
    <div class="toast-actions"><button class="ghost toast-details">Details</button></div>`;
  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 220);
  };
  (toast.querySelector(".toast-details") as HTMLButtonElement)
    .addEventListener("click", () => { dismiss(); showResults(results); });
  $("toasts").appendChild(toast);
  setTimeout(dismiss, 6000);
}

sendBtn.addEventListener("click", () => sendItems([...selected.values()]));
sendThisBtn.addEventListener("click", () => {
  if (currentPreview) sendItems([currentPreview]);
});

function showResults(results: SendResult[]): void {
  const rows = results.map((r) => {
    const [cls, glyph] = r.warning ? ["warn", "⚠️"] : r.ok ? ["ok", "✓"] : ["fail", "✗"];
    return `
    <tr><td class="${cls}">${glyph}</td>
    <td>${escapeHtml(r.title)}${r.ok ? "" : `<br><small>${escapeHtml(r.detail)}</small>`}</td></tr>`;
  });
  modalContent.innerHTML = `<h3>Send results</h3><table>${rows.join("")}</table>`;
  closeGuard = null; // this content replaced whatever the guard was protecting
  modal.showModal();
}

// ---------- keyboard triage ----------

function refreshKbdFocus(): void {
  emailList.querySelectorAll(".email-card").forEach((c) => c.classList.remove("kbd-focus"));
  itemsPane.querySelectorAll(".item-row").forEach((r) => r.classList.remove("kbd-focus"));
  if (focusPane === "emails" && emailFocusIdx >= 0) {
    const nl = emailOrder[emailFocusIdx];
    const card = emailList.querySelector(`[data-email-id="${nl?.id}"]`);
    card?.classList.add("kbd-focus");
    card?.scrollIntoView({ block: "nearest" });
  } else if (focusPane === "items" && itemFocusIdx >= 0) {
    const item = itemOrder[itemFocusIdx];
    if (item) {
      const key = selKey(item.kind, item.msg_id, item.url);
      const row = itemsPane.querySelector(`[data-key="${CSS.escape(key)}"]`);
      row?.classList.add("kbd-focus");
      row?.scrollIntoView({ block: "nearest" });
    }
  }
}

document.addEventListener("keydown", (e) => {
  if (modal.open || e.metaKey || e.ctrlKey || e.altKey) return;
  const move = (delta: number) => {
    if (focusPane === "emails") {
      emailFocusIdx = Math.min(Math.max(emailFocusIdx + delta, 0), emailOrder.length - 1);
    } else {
      itemFocusIdx = Math.min(Math.max(itemFocusIdx + delta, 0), itemOrder.length - 1);
    }
    refreshKbdFocus();
  };
  switch (e.key) {
    case "ArrowDown": case "j": e.preventDefault(); move(1); break;
    case "ArrowUp": case "k": e.preventDefault(); move(-1); break;
    case "Tab":
    case "ArrowRight":
    case "ArrowLeft": {
      e.preventDefault();
      focusPane = focusPane === "emails" ? "items" : "emails";
      if (focusPane === "items" && itemFocusIdx < 0 && itemOrder.length > 0) itemFocusIdx = 0;
      refreshKbdFocus();
      break;
    }
    case "Enter": {
      e.preventDefault();
      if (focusPane === "emails" && emailOrder[emailFocusIdx]) {
        activateEmail(emailOrder[emailFocusIdx]);
      } else if (focusPane === "items" && itemOrder[itemFocusIdx]) {
        previewItem(itemOrder[itemFocusIdx]);
      }
      break;
    }
    case " ": {
      if (focusPane !== "items" || !itemOrder[itemFocusIdx]) break;
      e.preventDefault();
      const item = itemOrder[itemFocusIdx];
      const key = selKey(item.kind, item.msg_id, item.url);
      if (selected.has(key)) selected.delete(key);
      else selected.set(key, item);
      const active = newsletters.find((n) => n.id === activeId);
      if (active) renderItems(active);
      updateSendBtn();
      break;
    }
    case "s": case "S": {
      e.preventDefault();
      if (selected.size > 0) sendItems([...selected.values()]);
      else if (currentPreview) sendItems([currentPreview]);
      break;
    }
    case "d": case "D": {
      e.preventDefault();
      toggleDarkReading();
      break;
    }
  }
});

// ---------- resizable panes ----------

interface PaneSpec {
  varName: string; colId: string; resizerId: string; storageKey: string;
  min: number; max: number; def: number;
}
const panes: PaneSpec[] = [
  { varName: "--email-col-w", colId: "email-list", resizerId: "resizer-emails",
    storageKey: "colW-emails", min: 220, max: 480, def: 300 },
  { varName: "--items-col-w", colId: "items-col", resizerId: "resizer-items",
    storageKey: "colW-items", min: 240, max: 520, def: 330 },
];

function initResizers(): void {
  const root = document.documentElement;
  for (const p of panes) {
    const col = $(p.colId);
    const resizer = $(p.resizerId);
    const clamp = (w: number): number => Math.min(Math.max(w, p.min), p.max);
    const apply = (w: number): void => {
      root.style.setProperty(p.varName, `${Math.round(w)}px`);
    };

    // Restore saved width / collapsed state.
    const saved = localStorage.getItem(p.storageKey);
    if (saved === "collapsed") col.classList.add("collapsed");
    else if (saved !== null && !Number.isNaN(Number(saved))) apply(clamp(Number(saved)));

    resizer.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const wasCollapsed = col.classList.contains("collapsed");
      const startX = e.clientX;
      const startW = wasCollapsed ? p.def : col.getBoundingClientRect().width;
      resizer.classList.add("dragging");
      document.body.classList.add("resizing");
      resizer.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent): void => {
        if (wasCollapsed) col.classList.remove("collapsed");
        apply(clamp(startW + ev.clientX - startX));
      };
      const onUp = (): void => {
        resizer.classList.remove("dragging");
        document.body.classList.remove("resizing");
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onUp);
        if (!col.classList.contains("collapsed")) {
          localStorage.setItem(p.storageKey, String(Math.round(col.getBoundingClientRect().width)));
        }
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
    });

    resizer.addEventListener("dblclick", () => {
      const collapsed = col.classList.toggle("collapsed");
      localStorage.setItem(
        p.storageKey,
        collapsed ? "collapsed" : String(Math.round(col.getBoundingClientRect().width)),
      );
    });
  }
}

// ---------- log ----------

$("log-btn").addEventListener("click", async () => {
  const resp = await fetch("/api/log");
  const data = await resp.json();
  interface LogEntry { created_at: string; kind: string; title: string; status: string; detail: string }
  const rows = (data.entries as LogEntry[]).map((e) => `
    <tr><td class="${e.status === "sent" ? "ok" : "fail"}">${e.status === "sent" ? "✓" : "✗"}</td>
    <td>${localDateTime(parseUtc(e.created_at))}</td><td>${e.kind}</td>
    <td>${escapeHtml(e.title)}${e.detail ? `<br><small>${escapeHtml(e.detail)}</small>` : ""}</td></tr>`);
  modalContent.innerHTML = `<h3>Send log</h3><table>${rows.join("") || "<tr><td>Nothing sent yet.</td></tr>"}</table>`;
  closeGuard = null; // this content replaced whatever the guard was protecting
  modal.showModal();
});

$("modal-close").addEventListener("click", () => tryCloseModal());

// Esc reaches the dialog directly, bypassing tryCloseModal.
modal.addEventListener("cancel", (e) => {
  if (closeGuard && !closeGuard()) e.preventDefault();
  else closeGuard = null;
});

// Close on backdrop click. Backdrop hits target the <dialog> itself with
// coordinates outside its box; requiring the press to start there too keeps a
// text-selection drag that ends outside the dialog from dismissing it.
const onBackdrop = (e: MouseEvent): boolean => {
  if (e.target !== modal) return false;
  const r = modal.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};
let pressedBackdrop = false;
modal.addEventListener("pointerdown", (e) => { pressedBackdrop = onBackdrop(e); });
modal.addEventListener("click", (e) => {
  if (pressedBackdrop && onBackdrop(e)) tryCloseModal();
});

initResizers();
loadNewsletters();
// Returning from the native OAuth flow focuses the Chrome app window again.
// Refresh then so a newly written token takes effect without a manual reload.
window.addEventListener("focus", () => {
  if (awaitingAuthentication) void loadNewsletters();
});
