// reader-processor frontend: emails | items | paper preview, with keyboard triage.

interface Link {
  url: string; title: string; minutes: number | null; domain: string;
  junk: boolean; sent: boolean;
}
interface Newsletter {
  id: string; sender_display: string; subject: string; date_iso: string;
  body_sent: boolean; minutes: number | null; links: Link[];
}
interface SendResult { title: string; ok: boolean; detail: string }

type SelItem = { kind: "body" | "link"; msg_id: string; url?: string; title: string };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const emailList = $("email-list");
const itemsPane = $("items");
const previewFrame = $<HTMLIFrameElement>("preview");
const previewStatus = $("preview-status");
const previewTitle = $("preview-title");
const sendThisBtn = $<HTMLButtonElement>("send-this");
const sendBtn = $<HTMLButtonElement>("send-btn");
const sendCount = $("send-count");
const modal = $<HTMLDialogElement>("modal");
const modalContent = $("modal-content");

let newsletters: Newsletter[] = [];
let activeId: string | null = null;
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function updateSendBtn(): void {
  sendCount.textContent = String(selected.size);
  sendBtn.disabled = selected.size === 0;
}

// ---------- email list (left column) ----------

function dayLabel(iso: string): string {
  if (!iso) return "Unknown date";
  const d = new Date(iso);
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
    box.textContent = `Setup needed: ${data.error}`;
    emailList.appendChild(box);
    return;
  }
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
  const time = nl.date_iso ? nl.date_iso.slice(11, 16) : "";
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
    mark.textContent = " · ✓ sent";
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

let previewToken = 0;

function showPreviewStatus(text: string): void {
  previewStatus.textContent = text;
  previewStatus.classList.remove("hidden");
  previewFrame.classList.add("loading");
}

function showPreviewHtml(title: string, html: string): void {
  previewFrame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
    <style>body{font-family:Georgia,serif;max-width:640px;margin:1.5rem auto;padding:0 1.2rem 3rem;
    line-height:1.55;color:#111;background:#fff} img{max-width:100%;height:auto}
    a{color:#2563eb}</style>
    </head><body>${html}</body></html>`;
  previewStatus.classList.add("hidden");
  previewFrame.classList.remove("loading");
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
      showPreviewStatus(`⚠️ Could not render this newsletter: ${data.error ?? "server error"}`);
      return;
    }
    showPreviewHtml(data.title ?? item.title, data.html);
  } else {
    showPreviewStatus("Fetching article…");
    const resp = await fetch(`/api/preview/article?url=${encodeURIComponent(item.url!)}`);
    const data = await resp.json();
    if (token !== previewToken) return;
    if (!resp.ok) {
      showPreviewStatus(`⚠️ Could not extract this article: ${data.error}`);
      return;
    }
    showPreviewHtml(data.title, `<h2>${escapeHtml(data.title)}</h2>${data.html}`);
  }
}

// ---------- sending ----------

const bundleCb = $<HTMLInputElement>("bundle-cb");
bundleCb.checked = localStorage.getItem("bundleMode") === "1";
bundleCb.addEventListener("change", () =>
  localStorage.setItem("bundleMode", bundleCb.checked ? "1" : "0"));

async function sendItems(items: SelItem[]): Promise<void> {
  if (items.length === 0) return;
  sendBtn.disabled = true;
  sendThisBtn.disabled = true;
  sendCount.textContent = "…";
  try {
    const resp = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: items.map(({ kind, msg_id, url }) => ({ kind, msg_id, url })),
        bundle: bundleCb.checked && items.length > 1,
      }),
    });
    const data = await resp.json();
    showResults(data.results as SendResult[]);
    for (const item of items) selected.delete(selKey(item.kind, item.msg_id, item.url));
    await loadNewsletters();
  } catch (e) {
    showResults([{ title: "Send failed", ok: false, detail: String(e) }]);
  }
  updateSendBtn();
  sendThisBtn.disabled = currentPreview === null;
}

sendBtn.addEventListener("click", () => sendItems([...selected.values()]));
sendThisBtn.addEventListener("click", () => {
  if (currentPreview) sendItems([currentPreview]);
});

function showResults(results: SendResult[]): void {
  const rows = results.map((r) => `
    <tr><td class="${r.ok ? "ok" : "fail"}">${r.ok ? "✓" : "✗"}</td>
    <td>${escapeHtml(r.title)}${r.ok ? "" : `<br><small>${escapeHtml(r.detail)}</small>`}</td></tr>`);
  modalContent.innerHTML = `<h3>Send results</h3><table>${rows.join("")}</table>`;
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
  }
});

// ---------- log ----------

$("log-btn").addEventListener("click", async () => {
  const resp = await fetch("/api/log");
  const data = await resp.json();
  interface LogEntry { created_at: string; kind: string; title: string; status: string; detail: string }
  const rows = (data.entries as LogEntry[]).map((e) => `
    <tr><td class="${e.status === "sent" ? "ok" : "fail"}">${e.status === "sent" ? "✓" : "✗"}</td>
    <td>${e.created_at.replace("T", " ")}</td><td>${e.kind}</td>
    <td>${escapeHtml(e.title)}${e.detail ? `<br><small>${escapeHtml(e.detail)}</small>` : ""}</td></tr>`);
  modalContent.innerHTML = `<h3>Send log</h3><table>${rows.join("") || "<tr><td>Nothing sent yet.</td></tr>"}</table>`;
  modal.showModal();
});

$("modal-close").addEventListener("click", () => modal.close());

loadNewsletters();
