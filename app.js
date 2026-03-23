const triggers = document.querySelectorAll(".trigger");
const description = document.getElementById("description");
const scanBtn = document.getElementById("scan-btn");
const scanHint = document.getElementById("scan-hint");
const matchSection = document.getElementById("match-section");
const toast = document.getElementById("toast");
const envHint = document.getElementById("env-hint");
const recentList = document.getElementById("recent-list");
const recentsGrid = document.getElementById("recents-grid");
const globalSearch = document.getElementById("global-search");
const matchModal = document.getElementById("match-modal");
const matchModalTitle = document.getElementById("match-modal-title");
const matchModalDesc = document.getElementById("match-modal-desc");
const matchTrimHint = document.getElementById("match-trim-hint");
const uploadAssetPanel = document.getElementById("upload-asset-panel");
const uploadAssetInput = document.getElementById("upload-asset-input");
const uploadAssetPreview = document.getElementById("upload-asset-preview");
const uploadAssetPreviewImg = document.getElementById("upload-asset-preview-img");

let activeTrigger = "design";
/** @type {File | null} */
let smartMatchUploadFile = null;
let uploadPreviewObjectUrl = null;

/** Only show the strongest matches so the list stays short. */
const MAX_VISIBLE_MATCHES = 5;

/** Below this top score, we show “doesn’t match” instead of match cards (noise / junk queries). */
const MATCH_TOP_SCORE_MIN_SHOW = 23;

/** Low-information text brief (or no real tokens): if best score is still under this, skip cards. */
const MATCH_TOP_SCORE_MIN_LOWINFO_TEXT = 46;

/** Single dictionary-poor token (e.g. gibberish) with a weak top score → treat as no match. */
const MATCH_TOP_SCORE_SHALLOW_TEXT = 40;

/** When we still show cards, hint that fit is weak. */
const MATCH_TOP_SCORE_WEAK_HINT = 38;

/** @type {Record<string, object>} */
let matchByAssetId = {};

/** @type {"collab"|"duplicate"|"new"|null} */
let lastModalAction = null;

/** Asset for the open match modal (for switching to Collaborate). */
let modalContextAsset = null;

const COLLAB_ACTIVITY_KEY = "smartmatch_collab_activity_v1";

/** @typedef {{ kind: "collab"|"fork", owner: string, name: string, id: string, at: number }} CollabActivityRow */

function readCollabActivity() {
  try {
    const raw = sessionStorage.getItem(COLLAB_ACTIVITY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCollabActivity(rows) {
  sessionStorage.setItem(COLLAB_ACTIVITY_KEY, JSON.stringify(rows.slice(-30)));
}

function renderCollabActivityUi() {
  const items = readCollabActivity();
  const wrap = document.getElementById("collab-activity");
  const ul = document.getElementById("collab-activity-list");
  const strip = document.getElementById("collab-activity-strip");
  if (!items.length) {
    if (wrap) wrap.hidden = true;
    if (strip) strip.hidden = true;
    return;
  }
  const line = (x) => {
    const t = new Date(x.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (x.kind === "collab") return `${t} · To ${x.owner}: opened “${x.name}” (collaboration)`;
    return `${t} · To ${x.owner}: “${x.name}” used as starting point`;
  };
  if (ul && wrap) {
    ul.replaceChildren();
    items.slice(0, 8).forEach((x) => {
      const li = document.createElement("li");
      li.textContent = line(x);
      ul.appendChild(li);
    });
    wrap.hidden = false;
  }
  if (strip) {
    strip.textContent = `Last: ${line(items[0])}`;
    strip.hidden = false;
  }
}

/**
 * @param {"collab"|"fork"} kind
 * @param {object} asset
 */
function recordCollabActivity(kind, asset) {
  const name = asset?.name || asset?.id || "Untitled";
  const o = asset ? recentsOwnerLabel(asset, 0) : "—";
  const owner = o && o !== "—" ? o : "Owner";
  const rows = readCollabActivity();
  rows.unshift({ kind, owner, name, id: String(asset?.id ?? ""), at: Date.now() });
  writeCollabActivity(rows);
  renderCollabActivityUi();
}

/** Cached /api/assets for “Your designs” random preview. */
let workspaceCacheItems = [];

/** Recents category filter (`data-cat` value) or null = all. */
let recentsActiveCategory = null;

/** `designs` | `templates` | `smart` — title/category filters apply only on `templates`. */
let currentHomeTab = "smart";

/** Stand-in asset shown as “current design” on Your designs tab. */
let currentDesignAsset = null;

/** Top match when Smart Match alert is open. */
let lastSmartAlertMatch = null;

/** Up to two workspace assets shown on “Your designs”; each is polled for similarity. */
let activeDesignSlots = [];

/** @type {ReturnType<typeof setInterval> | null} */
let ydPollTimer = null;

/** Avoid back-to-back popups when two slots both hit the threshold. */
let lastGlobalSmartAlertAt = 0;

/** Session: don’t repeat the same source→match nudge. */
const seenSmartAlertPairs = new Set();

/** Show popup when best match is at or above this (0–100). */
const SMART_ALERT_MIN_CONFIDENCE = 55;

const SMART_ALERT_THROTTLE_MS = 10000;

const PALETTES = [
  "linear-gradient(135deg,#60a5fa,#a78bfa)",
  "linear-gradient(135deg,#34d399,#2dd4bf)",
  "linear-gradient(135deg,#f472b6,#fb923c)",
  "linear-gradient(135deg,#818cf8,#c084fc)",
  "linear-gradient(135deg,#38bdf8,#6366f1)",
  "linear-gradient(135deg,#fbbf24,#f97316)",
  "linear-gradient(135deg,#2dd4bf,#3b82f6)",
  "linear-gradient(135deg,#e879f9,#6366f1)",
];

function thumbStyle(i) {
  return PALETTES[i % PALETTES.length];
}

/** Fallback names when owner is the placeholder “Template library”, blank on a template row, or API is stale. */
const RECENTS_GENERIC_OWNERS = [
  "John Smith",
  "Emma Wilson",
  "Michael Brown",
  "Sarah Davis",
  "David Lee",
  "Jennifer Taylor",
  "Robert Moore",
  "Lisa Anderson",
  "James Thomas",
  "Maria Garcia",
  "William Martinez",
  "Patricia White",
  "Richard Harris",
  "Linda Clark",
  "Joseph Lewis",
  "Barbara Walker",
  "Thomas Hall",
  "Susan Allen",
  "Charles Young",
  "Karen King",
  "Daniel Wright",
  "Nancy Scott",
];

/**
 * Owner line for Recents, similar-template cards, and match results — never show the odd “Template library” placeholder.
 * @param {object} a — asset or match row (`id`, `owner`, `status`)
 * @param {number} index — row index for fallback name rotation
 */
function recentsOwnerLabel(a, index) {
  const id = a.id != null ? String(a.id) : "";
  if (id && workspaceCacheItems.length) {
    const cached = workspaceCacheItems.find((x) => x.id === id);
    const co = cached ? String(cached.owner || "").trim() : "";
    if (co && !/^template\s*library$/i.test(co)) {
      return co;
    }
  }
  const o = String(a.owner || "").trim();
  const templateRow = String(a.status || "").toLowerCase().includes("template");
  if (/^template\s*library$/i.test(o) || (templateRow && !o)) {
    return RECENTS_GENERIC_OWNERS[index % RECENTS_GENERIC_OWNERS.length];
  }
  return o || "—";
}

/**
 * City / region for owner (from workspace cache), or empty string.
 * @param {object} a — asset or match row
 * @param {number} index — unused; reserved for parity with `recentsOwnerLabel`
 */
function recentsOwnerLocation(a, _index) {
  const id = a.id != null ? String(a.id) : "";
  if (id && workspaceCacheItems.length) {
    const cached = workspaceCacheItems.find((x) => x.id === id);
    const loc = cached ? String(cached.ownerLocation || "").trim() : "";
    if (loc) return loc;
  }
  return String(a.ownerLocation || "").trim();
}

/** Min modeled confidence (0–100) to show in Your designs → similar templates list and left summary. */
const YD_MATCH_LIST_MIN_CONFIDENCE = 60;

/** Top row (closest match) — fixed demo display %. */
const YD_MATCH_FIRST_CARD_DISPLAY_SIMILARITY = 92;

/** Second row — fixed demo display %. */
const YD_MATCH_SECOND_CARD_DISPLAY_SIMILARITY = 78;

/** Third row onward — fixed demo display %. */
const YD_MATCH_CARD_DISPLAY_SIMILARITY = 98;

/** Fixed in-progress design (must exist in data/workspace.json). */
const YD_FIXED_IN_PROGRESS_IDS = ["yd-inprogress-coffee"];

/** Format pill text on Recents grid + sidebar (cycles; demo variety). */
const RECENTS_FORMAT_PILL_LABELS = ["Presentation", "Instagram post", "Print", "Flyer"];

/** @param {number} index */
function recentsFormatPillLabel(index) {
  return RECENTS_FORMAT_PILL_LABELS[index % RECENTS_FORMAT_PILL_LABELS.length];
}

/** Toggles env hint when the app isn’t served by the Smart Match server (e.g. file:// or wrong port). */
async function refreshHealth() {
  try {
    const h = await (await fetch("/api/health")).json();
    if (!h.modelReady) {
      if (envHint) envHint.hidden = false;
      return;
    }
    if (envHint) envHint.hidden = true;
  } catch {
    if (envHint) envHint.hidden = false;
  }
}

function renderAssets(items) {
  if (!recentList || !recentsGrid) return;
  recentList.replaceChildren();
  recentsGrid.replaceChildren();

  if (!items.length && workspaceCacheItems.length) {
    const empty = document.createElement("p");
    empty.className = "recents-empty";
    empty.setAttribute("role", "status");
    empty.textContent = "No designs match filter or category.";
    recentsGrid.appendChild(empty);
    return;
  }

  items.forEach((a, i) => {
    const thumb =
      a.thumbnail && publicAssetUrl(a.thumbnail)
        ? `<span class="recent-thumb recent-thumb--photo"><img src="${escapeHtml(publicAssetUrl(a.thumbnail))}" alt="" /></span>`
        : `<span class="recent-thumb" style="background:${thumbStyle(i)}"></span>`;
    const preview = a.thumbnail
      ? `<div class="recents-card-preview recents-card-preview--photo">
          <img src="${escapeHtml(publicAssetUrl(a.thumbnail))}" alt="" />
          <button type="button" class="recents-card-star" aria-label="Star">☆</button>
        </div>`
      : `<div class="recents-card-preview" style="--card-bg:${thumbStyle(i)}">
          <button type="button" class="recents-card-star" aria-label="Star">☆</button>
        </div>`;

    const li = document.createElement("li");
    li.className = "recent-item";
    li.innerHTML = `
      ${thumb}
      <div class="recent-meta">
        <div class="recent-name">${escapeHtml(a.title || a.name)}</div>
        <div class="recent-format">${escapeHtml(recentsFormatPillLabel(i))}</div>
        <div class="recent-owner">Owner: ${escapeHtml(recentsOwnerLabel(a, i))}</div>
      </div>`;
    recentList.appendChild(li);

    const card = document.createElement("article");
    card.className = "recents-card";
    card.innerHTML = `
      ${preview}
      <div class="recents-card-body">
        <span class="asset-format-pill asset-format-pill--small asset-format-pill--sentence">${escapeHtml(recentsFormatPillLabel(i))}</span>
        <p class="recents-card-name">${escapeHtml(a.title || a.name)}</p>
        <p class="recents-card-owner">Owner: ${escapeHtml(recentsOwnerLabel(a, i))}</p>
        <p class="recents-card-meta">${escapeHtml(a.status)}</p>
      </div>`;
    recentsGrid.appendChild(card);
  });
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** Flyer, Instagram post, Site / landing page, etc. — from API `designFormat` or fallback. */
function designFormatLabel(m) {
  const d = m && m.designFormat;
  if (d != null && String(d).trim()) return String(d).trim();
  return "Design";
}

/**
 * @param {object} asset
 * @param {string} category — `data-cat` from category row
 */
function recentsCategoryMatch(asset, category) {
  const fmt = String(asset.designFormat || designFormatLabel(asset)).toLowerCase();
  const title = String(asset.name || asset.title || "").toLowerCase();
  const blob = `${fmt} ${title}`;

  switch (category) {
    case "presentation":
      return /\bpresentation\b|slide|deck/.test(fmt);
    case "social":
      return /instagram|facebook|social post|social story|banner/.test(fmt) || /\b(instagram|facebook)\b/.test(title);
    case "video":
      return /\bvideo\b/.test(blob);
    case "print":
      return /flyer|poster|menu|print|ticket|leaflet|brochure/.test(fmt);
    default:
      return true;
  }
}

function getRecentsFilteredItems() {
  let items = workspaceCacheItems.slice();
  if (currentHomeTab !== "templates") {
    return items;
  }
  const searchEl = globalSearch ?? document.getElementById("global-search");
  const raw = searchEl ? String(searchEl.value).trim().toLowerCase() : "";
  if (raw) {
    items = items.filter((a) => String(a.name || a.title || "").toLowerCase().includes(raw));
  }
  if (recentsActiveCategory) {
    items = items.filter((a) => recentsCategoryMatch(a, recentsActiveCategory));
  }
  return items;
}

function syncRecentsCatPillUi() {
  document.querySelectorAll(".cat-pill[data-cat]").forEach((btn) => {
    const cat = btn.getAttribute("data-cat");
    const on = cat === recentsActiveCategory;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function applyRecentsFilters() {
  if (currentHomeTab !== "templates") {
    renderAssets(getRecentsFilteredItems());
  }
  renderTemplatesBrowsePanel();
}

/**
 * Template-library rows, filtered by title search + category when the Templates tab is active.
 */
function getTemplatesGridItems() {
  const allTemplates = workspaceCacheItems.filter((a) => String(a.status || "").toLowerCase().includes("template"));
  if (currentHomeTab !== "templates") {
    return allTemplates;
  }
  const searchEl = globalSearch ?? document.getElementById("global-search");
  const raw = searchEl ? String(searchEl.value).trim().toLowerCase() : "";
  let items = allTemplates;
  if (raw) {
    items = items.filter((a) => String(a.name || a.title || "").toLowerCase().includes(raw));
  }
  if (recentsActiveCategory) {
    items = items.filter((a) => recentsCategoryMatch(a, recentsActiveCategory));
  }
  return items;
}

/** Template-library rows only — thumbnails for the Templates tab. */
function renderTemplatesBrowsePanel() {
  const grid = document.getElementById("templates-browse-grid");
  const emptyEl = document.getElementById("templates-browse-empty");
  if (!grid) return;

  const allTemplates = workspaceCacheItems.filter((a) => String(a.status || "").toLowerCase().includes("template"));
  const items = getTemplatesGridItems();

  grid.replaceChildren();

  if (emptyEl) {
    if (currentHomeTab === "templates" && items.length === 0) {
      emptyEl.hidden = false;
      emptyEl.textContent =
        allTemplates.length === 0 ? "No templates in this workspace." : "No templates match your title filter or category.";
    } else {
      emptyEl.hidden = true;
      emptyEl.textContent = "";
    }
  }

  items.forEach((a) => {
    const art = document.createElement("article");
    art.className = "templates-browse-card";
    const name = escapeHtml(a.name || a.id || "Untitled");
    const fmt = escapeHtml(designFormatLabel(a));
    const thumb = a.thumbnail
      ? `<div class="templates-browse-thumb"><img src="${escapeHtml(publicAssetUrl(a.thumbnail))}" alt="" width="160" height="120" loading="lazy" /></div>`
      : `<div class="templates-browse-thumb templates-browse-thumb--ph" aria-hidden="true"></div>`;
    art.innerHTML = `${thumb}
      <div class="templates-browse-card-body">
        <p class="templates-browse-card-name">${name}</p>
        <p class="templates-browse-card-meta">${fmt}</p>
      </div>`;
    grid.appendChild(art);
  });
}

function clearRecentsFilters() {
  recentsActiveCategory = null;
  const el = document.getElementById("global-search");
  if (el) el.value = "";
  syncRecentsCatPillUi();
}

/**
 * Summary under each Your designs card: top template + counts (matches come from /api/match-from-asset, template library only).
 * @param {object[]} matches
 */
function formatYdSimilarSummaryHtml(matches) {
  const list = Array.isArray(matches) ? matches : [];
  const strong = list.filter((m) => typeof m.confidence === "number" && m.confidence >= YD_MATCH_LIST_MIN_CONFIDENCE);
  if (!strong.length) {
    return "No similar templates yet · auto-match (no brief typed)";
  }
  const top = strong[0];
  const n = strong.length;
  const topName = escapeHtml(top.name || top.id || "Template");
  const pct = YD_MATCH_FIRST_CARD_DISPLAY_SIMILARITY;
  return `Closest: <strong>${topName}</strong> <span class="yd-similar-pct">(${pct}%)</span> · <strong>${n}</strong> strong · see <span class="yd-powered">right</span>`;
}

function setYdSimilarLine(slotIdx, content, { asHtml = true } = {}) {
  const el = document.getElementById(`yd-similar-${slotIdx}`);
  if (!el) return;
  if (asHtml) el.innerHTML = content;
  else el.textContent = content;
}

function clearYdSimilarLines() {
  setYdSimilarLine(0, "", { asHtml: false });
}

/** Static file path from workspace → URL path (Express serves project root). */
function publicAssetUrl(path) {
  if (!path) return "";
  return `/${String(path).replace(/^\/+/, "")}`;
}

/** In-app full preview (same chrome as the app). @returns {boolean} */
function openDesignPreview(asset) {
  const shell = document.getElementById("design-preview");
  const img = document.getElementById("design-preview-img");
  const titleEl = document.getElementById("design-preview-title");
  if (!shell || !img || !titleEl) return false;
  const path = asset?.thumbnail;
  if (!path) return false;
  titleEl.textContent = asset.name || asset.id || "Design";
  img.src = publicAssetUrl(path);
  img.alt = asset.name || "";
  shell.hidden = false;
  document.body.style.overflow = "hidden";
  return true;
}

function closeDesignPreview() {
  const shell = document.getElementById("design-preview");
  const img = document.getElementById("design-preview-img");
  if (img) {
    img.removeAttribute("src");
    img.alt = "";
  }
  if (shell) shell.hidden = true;
  document.body.style.overflow = "";
}

function ownerInitialsForChat(owner) {
  const parts = String(owner || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] || "?").slice(0, 2).toUpperCase();
}

/** Demo team chat beside the icon rail (opens after “Notify owner & view design”). */
function openFakeChat(asset) {
  const rail = document.getElementById("fake-chat-rail");
  const sub = document.getElementById("fake-chat-sub");
  const fileLine = document.getElementById("fake-chat-file-line");
  const ownerLine = document.getElementById("fake-chat-owner-line");
  const thread = document.getElementById("fake-chat-thread");
  if (!rail || !sub || !thread) return;

  const owner = recentsOwnerLabel(asset, 0);
  const ownerDisp = owner && owner !== "—" ? owner : "Owner";
  const location = recentsOwnerLocation(asset, 0);
  const label = asset.name || asset.id || "design";
  const safeOwner = escapeHtml(ownerDisp);
  const safeLabel = escapeHtml(label);
  const initials = escapeHtml(ownerInitialsForChat(ownerDisp));

  if (fileLine) fileLine.textContent = label;
  if (ownerLine) {
    ownerLine.textContent = location ? `Owner: ${ownerDisp} · ${location}` : `Owner: ${ownerDisp}`;
  }

  thread.innerHTML = `
    <p class="fake-chat-system">You notified ${safeOwner} about “${safeLabel}”.</p>
    <div class="fake-chat-msg">
      <span class="fake-chat-avatar" aria-hidden="true">${initials}</span>
      <div class="fake-chat-bubble">
        <p>Thanks for the heads-up — opening the file now. Shout if you want to align on the hero or CTA.</p>
        <time>Just now</time>
      </div>
    </div>
    <div class="fake-chat-msg fake-chat-msg--you">
      <span class="fake-chat-avatar fake-chat-avatar--you" aria-hidden="true">JJ</span>
      <div class="fake-chat-bubble">
        <p>Perfect — I’ll review in preview.</p>
        <time>Just now</time>
      </div>
    </div>
  `;

  rail.hidden = false;
  rail.removeAttribute("aria-hidden");
  requestAnimationFrame(() => {
    rail.classList.add("is-open");
  });
}

function closeFakeChat() {
  const rail = document.getElementById("fake-chat-rail");
  if (!rail) return;
  rail.classList.remove("is-open");
  window.setTimeout(() => {
    rail.hidden = true;
    rail.setAttribute("aria-hidden", "true");
  }, 320);
}

/**
 * Renders the right-hand “similar templates” column (no popup).
 * @param {object[]} matches
 * @param {object} _sourceAsset
 */
function renderYdMatchesPanel(matches, _sourceAsset) {
  const summary = document.getElementById("yd-matches-summary");
  const wrap = document.getElementById("yd-match-list-wrap");
  const list = document.getElementById("yd-match-list");
  if (!summary || !list) return;

  const ranked = Array.isArray(matches) ? matches.filter((m) => typeof m.confidence === "number") : [];
  const eligible = ranked.filter((m) => m.confidence >= YD_MATCH_LIST_MIN_CONFIDENCE);

  for (const m of eligible.slice(0, 20)) {
    matchByAssetId[m.id] = m;
  }

  if (!ranked.length) {
    summary.textContent = "No matches yet · check server and retry.";
    list.replaceChildren();
    if (wrap) wrap.hidden = true;
    return;
  }

  if (wrap) wrap.hidden = false;

  if (!eligible.length) {
    summary.textContent = "No high-confidence matches yet.";
    list.replaceChildren();
    return;
  }

  const eligibleCount = eligible.length;
  const showRows = eligible.slice(0, 20);

  const versionWord = eligibleCount === 1 ? "VERSION" : "VERSIONS";
  summary.innerHTML = `<strong>${eligibleCount}</strong> ${versionWord} AT HIGH MATCH`;

  list.replaceChildren();
  showRows.forEach((m, idx) => {
    const art = document.createElement("article");
    art.className = "yd-match-card";
    const thumb = m.thumbnail
      ? `<div class="yd-match-card-thumb"><img src="${escapeHtml(publicAssetUrl(m.thumbnail))}" alt="" loading="lazy" /></div>`
      : `<div class="yd-match-card-thumb yd-match-card-thumb--ph" aria-hidden="true"></div>`;
    const ownerLine = escapeHtml(recentsOwnerLabel(m, idx));
    const rowPct =
      idx === 0
        ? YD_MATCH_FIRST_CARD_DISPLAY_SIMILARITY
        : idx === 1
          ? YD_MATCH_SECOND_CARD_DISPLAY_SIMILARITY
          : YD_MATCH_CARD_DISPLAY_SIMILARITY;
    const reasonText = m.reasoning != null && String(m.reasoning).trim() ? String(m.reasoning).trim() : "";
    const reasonBlock = reasonText
      ? `<p class="yd-match-card-reason"><span class="yd-match-card-reason-label">Why similar:</span> ${escapeHtml(reasonText)}</p>`
      : "";
    art.innerHTML = `${thumb}
      <div class="yd-match-card-body">
        <span class="asset-format-pill">${escapeHtml(designFormatLabel(m))}</span>
        <div class="yd-match-card-head">
          <span class="yd-match-card-title">${escapeHtml(m.name || m.id)}</span>
          <span class="yd-match-card-score">${rowPct}%</span>
        </div>
        ${reasonBlock}
        <p class="yd-owner-line">Owner: <strong>${ownerLine}</strong></p>
        <p class="yd-match-card-meta">${escapeHtml(m.status || "")}</p>
        <div class="yd-match-card-actions">
          <button type="button" class="btn btn-gradient match-act btn-collab-wide" data-match-action="collab" data-asset-id="${escapeHtml(m.id)}">Collaborate</button>
        </div>
      </div>`;
    list.appendChild(art);
  });
}

function templatePreviewHtml(m) {
  if (!m.thumbnail) return "";
  const src = publicAssetUrl(m.thumbnail);
  const alt = m.name || "Template preview";
  return `<figure class="match-card-figure">
    <img class="match-card-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" />
    <figcaption class="match-card-caption">Template preview</figcaption>
  </figure>`;
}

function annotationsHtml(m) {
  const ann = m.annotations;
  if (!Array.isArray(ann) || !ann.length) return "";
  const items = ann.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  return `<aside class="match-card-annotations" aria-label="Annotated regions and copy">
    <p class="match-card-annotations-title">In this design</p>
    <ol class="match-card-annotations-list">${items}</ol>
  </aside>`;
}

/** Mini bar chart for local multi-signal scores (0–100). */
function signalBarsHtml(m) {
  const s = m.signalScores;
  if (!s || typeof s.semantic !== "number") return "";
  const rows = [
    { key: "semantic", label: "Meaning", className: "semantic" },
    { key: "keyword", label: "Keywords", className: "keyword" },
    { key: "color", label: "Color", className: "color" },
    { key: "visual", label: "Visual", className: "visual" },
  ];
  const parts = rows.map(
    ({ key, label, className }) => `
      <div class="match-signal-row">
        <span class="match-signal-label">${escapeHtml(label)}</span>
        <div class="match-signal-track" role="presentation">
          <div class="match-signal-fill match-signal-fill--${className}" style="width:${s[key]}%"></div>
        </div>
        <span class="match-signal-pct">${s[key]}%</span>
      </div>`,
  );
  return `<div class="match-signal-bars" aria-label="Scores by signal">${parts.join("")}</div>`;
}

async function loadWorkspaceList() {
  try {
    const r = await fetch("/api/assets");
    if (!r.ok) throw new Error();
    const items = await r.json();
    workspaceCacheItems = items;
    applyRecentsFilters();
  } catch {
    workspaceCacheItems = [];
    applyRecentsFilters();
  }
}

/** Wait for `/api/assets` so fixed IDs (e.g. yd-inprogress-*) exist before picking slots. */
async function ensureWorkspaceCacheLoaded() {
  if (workspaceCacheItems.length) return;
  await loadWorkspaceList();
}

function fillYdSlot(idx, asset) {
  const ydName = document.getElementById(`yd-name-${idx}`);
  const ydImg = document.getElementById(`yd-img-${idx}`);
  const ydFb = document.getElementById(`yd-fb-${idx}`);
  const slotEl = document.getElementById(`yd-slot-${idx}`);
  if (!ydName || !ydImg || !ydFb || !slotEl) return;
  slotEl.hidden = false;
  ydName.textContent = asset.name || asset.id || "Untitled";
  setYdSimilarLine(idx, "Finding similar templates…", { asHtml: false });
  if (asset.thumbnail) {
    ydImg.src = publicAssetUrl(asset.thumbnail);
    ydImg.alt = asset.name || "";
    ydImg.hidden = false;
    ydFb.hidden = true;
  } else {
    ydImg.hidden = true;
    ydFb.hidden = false;
    ydFb.style.background = thumbStyle(idx);
  }
}

async function initYourDesignsPreview() {
  await ensureWorkspaceCacheLoaded();

  if (!workspaceCacheItems.length) {
    const n0 = document.getElementById("yd-name-0");
    if (n0) n0.textContent = "Couldn’t load workspace.";
    clearYdSimilarLines();
    return;
  }

  const pool = workspaceCacheItems.filter((a) => a.thumbnail);
  const pickFrom = pool.length ? pool : workspaceCacheItems;
  const hint = document.getElementById("yd-auto-hint");

  const byId = Object.fromEntries(workspaceCacheItems.map((a) => [a.id, a]));
  const fixedPicks = YD_FIXED_IN_PROGRESS_IDS.map((id) => byId[id]).filter(Boolean);

  if (!pickFrom.length) {
    const n0 = document.getElementById("yd-name-0");
    if (n0) n0.textContent = "No workspace files";
    clearYdSimilarLines();
    const img0 = document.getElementById("yd-img-0");
    const fb0 = document.getElementById("yd-fb-0");
    if (img0) img0.hidden = true;
    if (fb0) {
      fb0.hidden = false;
      fb0.style.background = thumbStyle(0);
    }
    activeDesignSlots = [];
    return;
  }

  let picks;
  if (fixedPicks.length >= 1) {
    picks = [fixedPicks[0]];
  } else {
    const r = Math.floor(Math.random() * pickFrom.length);
    picks = [pickFrom[r]];
  }

  activeDesignSlots = picks;
  currentDesignAsset = picks[0] ?? null;

  fillYdSlot(0, picks[0]);
  const ydSum = document.getElementById("yd-matches-summary");
  if (ydSum) ydSum.textContent = "Matching to template library…";
  document.getElementById("yd-match-list")?.replaceChildren();
  const ydWrap = document.getElementById("yd-match-list-wrap");
  if (ydWrap) ydWrap.hidden = true;

  if (hint) {
    hint.hidden = false;
    hint.textContent = "Finding similar files…";
  }
}

function stopYourDesignsPolling() {
  if (ydPollTimer) {
    clearInterval(ydPollTimer);
    ydPollTimer = null;
  }
}

async function pollYourDesignsForSimilarity() {
  if (!activeDesignSlots.length) return;
  const hint = document.getElementById("yd-auto-hint");
  let hadError = false;
  const asset = activeDesignSlots[0];
  try {
    const result = await matchFromAssetApi(asset.id);
    setYdSimilarLine(0, formatYdSimilarSummaryHtml(result.matches));
    renderYdMatchesPanel(result.matches, asset);
  } catch (e) {
    hadError = true;
    const msg =
      typeof e === "object" && e !== null && "message" in e && String(e.message).includes("Failed to fetch")
        ? "Couldn’t load similarity · run npm start and open http://localhost:3000"
        : e instanceof Error
          ? e.message
          : "Couldn’t load similarity";
    setYdSimilarLine(0, msg, { asHtml: false });
    renderYdMatchesPanel([], asset);
    if (hint) {
      hint.hidden = false;
      hint.textContent = msg;
    }
  }
  if (!hadError && hint) hint.hidden = true;
}

function startYourDesignsPolling() {
  stopYourDesignsPolling();
  if (!activeDesignSlots.length) return;
  pollYourDesignsForSimilarity();
  ydPollTimer = setInterval(pollYourDesignsForSimilarity, 10000);
}

function setHomeView(tab) {
  currentHomeTab = tab;

  const vDesigns = document.getElementById("view-designs");
  const vTemplates = document.getElementById("view-templates");
  const vSmart = document.getElementById("view-smart");
  [vDesigns, vTemplates, vSmart].forEach((el) => {
    if (el) el.hidden = true;
  });
  if (tab === "designs" && vDesigns) vDesigns.hidden = false;
  else if (tab === "templates" && vTemplates) vTemplates.hidden = false;
  else if (vSmart) vSmart.hidden = false;

  const recentsSection = document.getElementById("recents-section");
  const slotPark = document.getElementById("recents-section-park");
  /** Recents grid stays parked off-screen (not under Templates or Smart Match). */
  if (recentsSection && slotPark) {
    slotPark.appendChild(recentsSection);
  }

  const recentsRail = document.getElementById("recents-rail");
  if (recentsRail) recentsRail.hidden = true;

  if (tab !== "templates") {
    clearRecentsFilters();
  }

  document.querySelectorAll("[data-nav-tab]").forEach((btn) => {
    const navTab = btn.getAttribute("data-nav-tab");
    const isProjects = btn.getAttribute("data-nav-projects") === "true";
    const active = navTab === tab && (tab !== "designs" || isProjects);
    btn.classList.toggle("is-active", active);
  });

  if (tab === "designs") {
    initYourDesignsPreview().then(() => startYourDesignsPolling());
  } else {
    stopYourDesignsPolling();
  }

  applyRecentsFilters();
}

function closeSmartMatchAlert() {
  const el = document.getElementById("smart-match-alert");
  if (el) el.hidden = true;
  lastSmartAlertMatch = null;
}

function openSmartMatchAlert(match, sourceAsset) {
  lastSmartAlertMatch = match;
  const src = sourceAsset ?? currentDesignAsset;
  const el = document.getElementById("smart-match-alert");
  const sub = document.getElementById("sma-sub");
  const meta = document.getElementById("sma-meta");
  const mimg = document.getElementById("sma-match-img");
  const yours = document.getElementById("sma-yours");
  if (!el || !sub || !meta || !mimg || !yours) return;

  sub.textContent = `Close match · ${match.confidence}%`;
  meta.textContent = [match.name, recentsOwnerLabel(match, 0), match.status].filter(Boolean).join(" · ");

  if (match.thumbnail) {
    mimg.src = publicAssetUrl(match.thumbnail);
    mimg.alt = match.name || "";
    mimg.hidden = false;
  } else {
    mimg.hidden = true;
  }

  yours.replaceChildren();
  if (src?.thumbnail) {
    const im = document.createElement("img");
    im.className = "sma-thumb-img";
    im.src = publicAssetUrl(src.thumbnail);
    im.alt = src.name || "Your design";
    yours.appendChild(im);
  } else {
    const ph = document.createElement("div");
    ph.className = "sma-placeholder";
    ph.textContent = "Your design";
    yours.appendChild(ph);
  }

  el.hidden = false;
}

function maybeShowSmartMatchAlert(result, sourceAsset) {
  if (result?.imageUnreadable) return;
  const top = result.matches?.[0];
  if (!top || typeof top.confidence !== "number") return;
  if (top.confidence < SMART_ALERT_MIN_CONFIDENCE) return;
  const source = sourceAsset ?? currentDesignAsset;
  if (source && top.id === source.id) return;

  const pairKey = `${source?.id ?? "scan"}->${top.id}`;
  if (seenSmartAlertPairs.has(pairKey)) return;
  if (Date.now() - lastGlobalSmartAlertAt < SMART_ALERT_THROTTLE_MS) return;

  seenSmartAlertPairs.add(pairKey);
  lastGlobalSmartAlertAt = Date.now();
  openSmartMatchAlert(top, source);
}

globalSearch?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (description && globalSearch.value.trim()) {
      description.value = globalSearch.value.trim();
      scanBtn?.click();
    }
  }
});

function syncUploadPanelVisibility() {
  if (!uploadAssetPanel) return;
  uploadAssetPanel.hidden = activeTrigger !== "upload";
}

triggers.forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTrigger = btn.dataset.trigger || "design";
    triggers.forEach((b) => b.classList.toggle("is-active", b === btn));
    syncUploadPanelVisibility();
  });
});
syncUploadPanelVisibility();

uploadAssetInput?.addEventListener("change", () => {
  const f = uploadAssetInput.files?.[0];
  smartMatchUploadFile = f || null;
  if (uploadPreviewObjectUrl) {
    URL.revokeObjectURL(uploadPreviewObjectUrl);
    uploadPreviewObjectUrl = null;
  }
  if (f && uploadAssetPreviewImg && uploadAssetPreview) {
    uploadPreviewObjectUrl = URL.createObjectURL(f);
    uploadAssetPreviewImg.src = uploadPreviewObjectUrl;
    uploadAssetPreview.hidden = false;
  } else if (uploadAssetPreview) {
    uploadAssetPreview.hidden = true;
  }
});

document.getElementById("upload-asset-clear")?.addEventListener("click", () => {
  smartMatchUploadFile = null;
  if (uploadAssetInput) uploadAssetInput.value = "";
  if (uploadPreviewObjectUrl) {
    URL.revokeObjectURL(uploadPreviewObjectUrl);
    uploadPreviewObjectUrl = null;
  }
  if (uploadAssetPreviewImg) uploadAssetPreviewImg.removeAttribute("src");
  if (uploadAssetPreview) uploadAssetPreview.hidden = true;
});

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
}

function renderMatches(data) {
  const list = document.getElementById("match-list");
  const empty = document.getElementById("match-empty");
  const source = document.getElementById("match-source");
  const queryHint = document.getElementById("match-query-hint");
  const all = data.matches || [];
  const isTextSource = data.source === "local" || data.source === "claude";
  const unusableImage = Boolean(data.imageUnreadable);

  if (source) {
    if (data.source === "claude") {
      source.textContent =
        "Claude · semantic ranking from your brief—use it to pick the right owner on a busy team.";
    } else if (data.source === "local-upload") {
      source.textContent = unusableImage
        ? "Image upload"
        : "Upload: palette + thumbnail color vs library, plus text embeddings (local, not vision AI).";
    } else {
      source.textContent =
        "Local scorer · meaning, keywords, color, layout—surfaces overlap before squads duplicate briefs.";
    }
  }

  if (unusableImage) {
    matchByAssetId = {};
    if (matchTrimHint) {
      matchTrimHint.hidden = true;
      matchTrimHint.textContent = "";
    }
    if (queryHint) {
      queryHint.hidden = true;
      queryHint.textContent = "";
    }
    if (empty) {
      empty.textContent =
        data.userMessage ||
        "This image could not be read. It doesn’t match anything in your workspace—try JPEG, PNG, WebP, or GIF.";
      empty.hidden = false;
    }
    if (list) list.replaceChildren();
    return;
  }

  if (!all.length) {
    matchByAssetId = {};
    if (matchTrimHint) {
      matchTrimHint.hidden = true;
      matchTrimHint.textContent = "";
    }
    if (queryHint) {
      queryHint.hidden = true;
      queryHint.textContent = "";
    }
    if (empty) {
      empty.textContent = "No strong match—add context or change the reference and run again.";
      empty.hidden = false;
    }
    if (list) list.replaceChildren();
    return;
  }

  const topScore = all[0]?.confidence ?? 0;
  const shallowGibberish =
    isTextSource &&
    Boolean(data.shallowTextQuery) &&
    topScore < MATCH_TOP_SCORE_SHALLOW_TEXT;
  const hideCardsForWeakQuery =
    topScore < MATCH_TOP_SCORE_MIN_SHOW ||
    (isTextSource &&
      topScore < MATCH_TOP_SCORE_MIN_LOWINFO_TEXT &&
      (data.lowInformationQuery || data.noQueryTokens)) ||
    shallowGibberish;

  const matches = hideCardsForWeakQuery ? [] : all.slice(0, MAX_VISIBLE_MATCHES);
  matchByAssetId = Object.fromEntries(matches.map((m) => [m.id, m]));

  if (matchTrimHint) {
    if (!hideCardsForWeakQuery && all.length > MAX_VISIBLE_MATCHES) {
      matchTrimHint.textContent = `Top ${MAX_VISIBLE_MATCHES} of ${all.length} · edit brief and re-run to refresh.`;
      matchTrimHint.hidden = false;
    } else {
      matchTrimHint.hidden = true;
      matchTrimHint.textContent = "";
    }
  }

  if (hideCardsForWeakQuery) {
    if (empty) {
      empty.hidden = false;
      const thinLanguage =
        (data.lowInformationQuery || data.noQueryTokens || shallowGibberish) &&
        topScore < MATCH_TOP_SCORE_MIN_LOWINFO_TEXT;
      empty.textContent = thinLanguage
        ? "That doesn’t match anything useful here—there isn’t enough real language for meaning or keywords to work (e.g. symbols, tags, or gibberish). Use a short plain-language brief and run again."
        : "That doesn’t match anything in your workspace closely enough. Try a clearer brief or a different image.";
    }
    if (queryHint) {
      queryHint.hidden = true;
      queryHint.textContent = "";
    }
    if (list) list.replaceChildren();
    return;
  }

  if (queryHint) {
    const lowInfo =
      data.lowInformationQuery &&
      (data.source === "local" || data.source === "local-upload" || data.source === "claude");
    if (lowInfo) {
      queryHint.textContent =
        data.source === "local-upload"
          ? "If your text brief is empty or very short, meaning and keyword matching won’t help much—results lean on color and the image. Add a few words (topic, brand, format) for stronger overlap."
          : "If your prompt is too short, matching often won’t do well on meaning or keywords—add a few concrete words (topic, format, audience) and run again.";
      queryHint.hidden = false;
    } else if (topScore < MATCH_TOP_SCORE_WEAK_HINT) {
      queryHint.textContent =
        "Best matches below are only a weak fit—nothing lines up strongly with what you entered.";
      queryHint.hidden = false;
    } else {
      queryHint.hidden = true;
      queryHint.textContent = "";
    }
  }

  if (!list) return;
  list.replaceChildren();
  if (!matches.length) {
    if (empty) {
      empty.textContent = "No strong match—add context or change the reference and run again.";
      empty.hidden = false;
    }
    return;
  }
  if (empty) empty.hidden = true;
  matches.forEach((m, idx) => {
    const el = document.createElement("article");
    el.className = "match-card-item";
    const signals = (m.matchSignals || [])
      .map((s) => `<span class="signal-chip">${escapeHtml(s)}</span>`)
      .join(" ");
    el.innerHTML = `
      <span class="asset-format-pill">${escapeHtml(designFormatLabel(m))}</span>
      <div class="match-card-head">
        <span class="match-card-title">${escapeHtml(m.name || m.id)}</span>
        <span class="match-card-score" title="Similarity">${escapeHtml(String(m.confidence))}%</span>
      </div>
      <p class="match-card-owner-line">Owner: <strong>${escapeHtml(recentsOwnerLabel(m, idx))}</strong></p>
      <p class="match-card-meta">${escapeHtml(m.status || "")}</p>
      ${templatePreviewHtml(m)}
      ${annotationsHtml(m)}
      ${signalBarsHtml(m)}
      <p class="match-card-reason">${escapeHtml(m.reasoning || "")}</p>
      <div class="match-card-signals">${signals}</div>
      <div class="match-card-actions match-card-actions--collab-first">
        <button type="button" class="btn btn-gradient match-act btn-collab-wide" data-match-action="collab">Collaborate</button>
        <button type="button" class="btn btn-outline match-act" data-match-action="duplicate">Start from this</button>
        <button type="button" class="btn btn-ghost match-act" data-match-action="new">New design</button>
      </div>`;
    el.querySelectorAll(".match-act").forEach((btn) => {
      btn.dataset.assetId = m.id;
    });
    list.appendChild(el);
  });
}

function closeMatchModal() {
  const previewWrap = document.getElementById("match-modal-preview");
  const previewImg = document.getElementById("match-modal-preview-img");
  if (previewImg) {
    previewImg.removeAttribute("src");
    previewImg.alt = "";
  }
  if (previewWrap) previewWrap.hidden = true;
  const primaryBtn = document.getElementById("match-modal-primary");
  if (primaryBtn) primaryBtn.hidden = true;
  if (matchModal) matchModal.hidden = true;
  if (lastModalAction === "new" && matchSection) {
    matchSection.hidden = true;
  }
  lastModalAction = null;
  modalContextAsset = null;
}

function openMatchActionModal(action, asset) {
  if (!matchModal || !matchModalTitle || !matchModalDesc) return;
  modalContextAsset = asset;
  lastModalAction = action;
  const name = asset?.name || asset?.id || "this design";
  const safe = (s) => String(s);
  const previewWrap = document.getElementById("match-modal-preview");
  const previewImg = document.getElementById("match-modal-preview-img");
  const primaryBtn = document.getElementById("match-modal-primary");

  if (previewWrap) previewWrap.hidden = true;
  if (previewImg) {
    previewImg.removeAttribute("src");
    previewImg.alt = "";
  }

  const owner = asset ? recentsOwnerLabel(asset, 0) : "—";
  const ownerStrong = owner && owner !== "—" ? `<strong>${escapeHtml(owner)}</strong>` : "the owner";

  if (action === "collab") {
    matchModalTitle.textContent = "Collaborate";
    matchModalDesc.innerHTML = `${ownerStrong} is notified when you join. Full preview opens here—fewer “who owns this?” loops on big teams.`;
    if (asset?.thumbnail && previewImg && previewWrap) {
      previewImg.src = publicAssetUrl(asset.thumbnail);
      previewImg.alt = safe(name);
      previewWrap.hidden = false;
    }
    if (primaryBtn) {
      primaryBtn.hidden = false;
      primaryBtn.textContent = "Notify owner & view design";
    }
  } else if (action === "duplicate") {
    matchModalTitle.textContent = "Starting point";
    matchModalDesc.innerHTML = `${ownerStrong} is notified when copies are created from this design. The preview opens here so you can confirm layout before your fork.`;
    if (asset?.thumbnail && previewImg && previewWrap) {
      previewImg.src = publicAssetUrl(asset.thumbnail);
      previewImg.alt = safe(name);
      previewWrap.hidden = false;
    }
    if (primaryBtn) {
      primaryBtn.hidden = false;
      primaryBtn.textContent = "Notify owner & view source";
    }
  } else {
    matchModalTitle.textContent = "New design";
    matchModalDesc.textContent = `Blank canvas instead of “${safe(name)}”.`;
    if (primaryBtn) primaryBtn.hidden = true;
  }

  matchModal.hidden = false;
}

document.getElementById("match-modal-primary")?.addEventListener("click", () => {
  const asset = modalContextAsset;
  const action = lastModalAction;
  if (!asset || !action || action === "new") return;
  const o = recentsOwnerLabel(asset, 0);
  const ownerDisp = o && o !== "—" ? o : "Owner";
  const label = asset.name || asset.id || "design";
  const hasFile = Boolean(asset.thumbnail);
  if (action === "collab") {
    recordCollabActivity("collab", asset);
    closeMatchModal();
    openFakeChat(asset);
    if (!hasFile) showToast(`Notified ${ownerDisp} · no preview file on this asset`);
    else {
      const opened = openDesignPreview(asset);
      showToast(
        opened
          ? `Notified ${ownerDisp} · viewing “${label}”`
          : `Notified ${ownerDisp} · preview unavailable`,
      );
    }
    return;
  }
  if (action === "duplicate") {
    recordCollabActivity("fork", asset);
    closeMatchModal();
    if (!hasFile) showToast(`Notified ${ownerDisp} · fork logged (no preview file)`);
    else {
      const opened = openDesignPreview(asset);
      showToast(
        opened
          ? `Notified ${ownerDisp} · source · “${label}”`
          : `Notified ${ownerDisp} · preview unavailable`,
      );
    }
  }
});

document.getElementById("design-preview-close")?.addEventListener("click", closeDesignPreview);
document.querySelector("[data-close-design-preview]")?.addEventListener("click", closeDesignPreview);

document.getElementById("fake-chat-close")?.addEventListener("click", closeFakeChat);

document.querySelectorAll(".nav-team-avatar").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-team-avatar").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
  });
});

function handleMatchListActionClick(e) {
  const btn = e.target.closest(".match-act");
  if (!btn || !(btn instanceof HTMLButtonElement)) return;
  const id = btn.dataset.assetId;
  const action = btn.dataset.matchAction;
  if (!id || !action) return;
  const asset = matchByAssetId[id];
  if (!asset) return;
  openMatchActionModal(action, asset);
}

document.getElementById("match-list")?.addEventListener("click", handleMatchListActionClick);
document.getElementById("yd-match-list")?.addEventListener("click", handleMatchListActionClick);

document.getElementById("match-modal-close")?.addEventListener("click", closeMatchModal);
matchModal?.querySelector("[data-close-match-modal]")?.addEventListener("click", closeMatchModal);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const dp = document.getElementById("design-preview");
  if (dp && !dp.hidden) {
    closeDesignPreview();
    return;
  }
  const fcr = document.getElementById("fake-chat-rail");
  if (fcr && !fcr.hidden && fcr.classList.contains("is-open")) {
    closeFakeChat();
    return;
  }
  const sma = document.getElementById("smart-match-alert");
  if (sma && !sma.hidden) {
    closeSmartMatchAlert();
    return;
  }
  if (matchModal && !matchModal.hidden) closeMatchModal();
});

document.querySelectorAll("[data-nav-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.getAttribute("data-nav-tab");
    if (tab) setHomeView(tab);
  });
});

function goToSmartMatchEntry() {
  setHomeView("smart");
  const flow = document.getElementById("flow");
  const desc = document.getElementById("description");
  flow?.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => desc?.focus(), 300);
}

document.querySelector(".templates-smart-link")?.addEventListener("click", goToSmartMatchEntry);

document.getElementById("sma-collab")?.addEventListener("click", () => {
  if (!lastSmartAlertMatch) return;
  const m = lastSmartAlertMatch;
  closeSmartMatchAlert();
  openMatchActionModal("collab", m);
});

document.getElementById("sma-dismiss")?.addEventListener("click", closeSmartMatchAlert);
document.querySelector("[data-close-sm-alert]")?.addEventListener("click", closeSmartMatchAlert);

async function matchWithApi(query) {
  const res = await fetch("/api/match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, trigger: activeTrigger }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || res.statusText || "Match failed");
  }
  return body;
}

/**
 * @param {File} file
 * @param {string} queryExtra — optional brief text combined with image-derived palette
 */
async function matchWithImageApi(file, queryExtra) {
  const fd = new FormData();
  fd.append("image", file, file.name);
  if (queryExtra) fd.append("query", queryExtra);
  const res = await fetch("/api/match-from-image", { method: "POST", body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        "Image match API not found (404). Another app may be using this port — stop it, run npm start from the smartmatch folder, then refresh the page.",
      );
    }
    throw new Error(body.error || res.statusText || "Match failed");
  }
  return body;
}

async function matchFromAssetApi(assetId) {
  const res = await fetch("/api/match-from-asset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetId, templateOnly: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || res.statusText || "Match failed");
  }
  return body;
}

scanBtn.addEventListener("click", async () => {
  const text = description.value.trim();
  const isUpload = activeTrigger === "upload";

  if (isUpload) {
    if (!smartMatchUploadFile) {
      showToast("Choose an image to upload first.");
      uploadAssetInput?.focus();
      return;
    }
  } else if (!text) {
    description.focus();
    return;
  }

  scanBtn.disabled = true;
  scanHint.hidden = false;
  scanHint.textContent = isUpload
    ? "Scanning your image against the workspace…"
    : "Matching your brief to the library…";
  matchSection.hidden = true;
  toast.hidden = true;

  try {
    const result = isUpload
      ? await matchWithImageApi(smartMatchUploadFile, text)
      : await matchWithApi(text);
    renderMatches(result);
    maybeShowSmartMatchAlert(result);
    scanHint.hidden = true;
    matchSection.hidden = false;
    await refreshHealth();
  } catch (e) {
    scanHint.hidden = true;
    const msg =
      e instanceof Error
        ? e.message
        : "Request failed · npm start → http://localhost:3000";
    showToast(msg);
  } finally {
    scanBtn.disabled = false;
  }
});

refreshHealth();
setInterval(refreshHealth, 15000);

document.getElementById("templates-category-row")?.addEventListener("click", (e) => {
  const btn = e.target && e.target.closest && e.target.closest("button[data-cat]");
  if (!btn) return;
  const cat = btn.getAttribute("data-cat");
  if (!cat) return;
  recentsActiveCategory = recentsActiveCategory === cat ? null : cat;
  syncRecentsCatPillUi();
  applyRecentsFilters();
});

function bindRecentsSearchInput() {
  const el = document.getElementById("global-search");
  if (!el || el.dataset.recentsBound === "1") return;
  el.dataset.recentsBound = "1";
  el.addEventListener("input", applyRecentsFilters);
  el.addEventListener("search", applyRecentsFilters);
}

bindRecentsSearchInput();

(async function bootHome() {
  await loadWorkspaceList();
  syncRecentsCatPillUi();
  renderCollabActivityUi();
  setHomeView("smart");
})();
