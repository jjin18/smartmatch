const triggers = document.querySelectorAll(".trigger");
const description = document.getElementById("description");
const scanBtn = document.getElementById("scan-btn");
const scanHint = document.getElementById("scan-hint");
const matchSection = document.getElementById("match-section");
const toast = document.getElementById("toast");
const sidebarCreate = document.getElementById("sidebar-create");
const modelStatus = document.getElementById("model-status");
const envHint = document.getElementById("env-hint");
const recentList = document.getElementById("recent-list");
const recentsGrid = document.getElementById("recents-grid");
const globalSearch = document.getElementById("global-search");
const matchModal = document.getElementById("match-modal");
const matchModalTitle = document.getElementById("match-modal-title");
const matchModalDesc = document.getElementById("match-modal-desc");
const matchTrimHint = document.getElementById("match-trim-hint");

let activeTrigger = "design";

/** Only show the strongest matches so the list stays short. */
const MAX_VISIBLE_MATCHES = 5;

/** @type {Record<string, object>} */
let matchByAssetId = {};

/** @type {"collab"|"duplicate"|"new"|null} */
let lastModalAction = null;

/** Asset for the open match modal (for switching to Collaborate). */
let modalContextAsset = null;

/** Cached /api/assets for “Your designs” random preview. */
let workspaceCacheItems = [];

/** Recents category filter (`data-cat` value) or null = all. */
let recentsActiveCategory = null;

/** `designs` | `templates` | `smart` — title/category filters apply only on `templates`. */
let currentHomeTab = "designs";

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

/** @param {"ready"|"warn"|"error"} kind */
function setModelBadge(kind, detail) {
  if (!modelStatus) return;
  modelStatus.classList.remove("is-ready", "is-error", "is-warn");
  modelStatus.textContent = detail || "—";
  if (kind === "ready") modelStatus.classList.add("is-ready");
  else if (kind === "warn") modelStatus.classList.add("is-warn");
  else modelStatus.classList.add("is-error");
}

async function refreshHealth() {
  try {
    const h = await (await fetch("/api/health")).json();
    if (!h.modelReady) {
      setModelBadge("error", "Check server · data/workspace.json");
      if (envHint) envHint.hidden = false;
      return;
    }
    const parts = [`${h.assetCount} assets`];
    parts.push(h.llm ? `LLM: ${h.anthropicModel || "Claude"}` : "Local scorer");
    parts.push(h.embeddings ? `embeddings ${h.embeddingDim ?? "?"}` : "no embeddings");
    if (h.envFileExists === false) {
      parts.push("no .env");
    }
    setModelBadge(h.embeddings || h.llm ? "ready" : "warn", parts.join(" · "));
    if (envHint) envHint.hidden = true;
  } catch {
    setModelBadge("error", "Run npm start · open in browser");
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
  renderAssets(getRecentsFilteredItems());
}

/** Template-library rows only — thumbnails for the Templates tab. */
function renderTemplatesBrowsePanel() {
  const grid = document.getElementById("templates-browse-grid");
  if (!grid) return;
  const templates = workspaceCacheItems.filter((a) => String(a.status || "").toLowerCase().includes("template"));
  grid.replaceChildren();
  templates.forEach((a) => {
    const art = document.createElement("article");
    art.className = "templates-browse-card";
    const name = escapeHtml(a.name || a.id || "Untitled");
    const fmt = escapeHtml(designFormatLabel(a));
    const thumb = a.thumbnail
      ? `<div class="templates-browse-thumb"><img src="${escapeHtml(publicAssetUrl(a.thumbnail))}" alt="" width="200" height="150" loading="lazy" /></div>`
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
    renderTemplatesBrowsePanel();
  } catch {
    workspaceCacheItems = [];
    applyRecentsFilters();
    renderTemplatesBrowsePanel();
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
  const slotTemplates = document.getElementById("recents-section-slot-templates");
  const slotSmart = document.getElementById("recents-section-slot-smart");
  /** Off-screen host when “Your designs” is active — not under #view-designs. */
  const slotPark = document.getElementById("recents-section-park");
  if (recentsSection && slotTemplates && slotSmart && slotPark) {
    if (tab === "templates") slotTemplates.appendChild(recentsSection);
    else if (tab === "smart") slotSmart.appendChild(recentsSection);
    else slotPark.appendChild(recentsSection);
  }

  const recentsRail = document.getElementById("recents-rail");
  if (recentsRail) recentsRail.hidden = true;

  if (tab !== "templates") {
    clearRecentsFilters();
  }

  document.querySelectorAll("[data-home-tab]").forEach((btn) => {
    const active = btn.getAttribute("data-home-tab") === tab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });

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

  if (workspaceCacheItems.length) {
    applyRecentsFilters();
  }
  renderTemplatesBrowsePanel();
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

sidebarCreate?.addEventListener("click", () => {
  document.getElementById("flow")?.scrollIntoView({ behavior: "smooth", block: "start" });
  description?.focus();
});

globalSearch?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (description && globalSearch.value.trim()) {
      description.value = globalSearch.value.trim();
      scanBtn?.click();
    }
  }
});

triggers.forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTrigger = btn.dataset.trigger;
    triggers.forEach((b) => b.classList.toggle("is-active", b === btn));
  });
});

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
}

function renderMatches(data) {
  const list = document.getElementById("match-list");
  const empty = document.getElementById("match-empty");
  const source = document.getElementById("match-source");
  const all = data.matches || [];
  const matches = all.slice(0, MAX_VISIBLE_MATCHES);
  matchByAssetId = Object.fromEntries(matches.map((m) => [m.id, m]));

  if (matchTrimHint) {
    if (all.length > MAX_VISIBLE_MATCHES) {
      matchTrimHint.textContent = `Top ${MAX_VISIBLE_MATCHES} of ${all.length} · edit brief and re-run to refresh.`;
      matchTrimHint.hidden = false;
    } else {
      matchTrimHint.hidden = true;
    }
  }

  if (source) {
    source.textContent =
      data.source === "claude"
        ? "Claude ranked from your brief (semantic, not keyword search)."
        : "Local: meaning · keywords · color · layout (see bars).";
  }
  if (!list) return;
  list.replaceChildren();
  if (!matches.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
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
  let title = "";
  let desc = "";
  if (action === "collab") {
    title = "Collaborate";
    const owner = asset ? recentsOwnerLabel(asset, 0) : "—";
    const who = owner && owner !== "—" ? owner : "the owner";
    desc = `We’ll notify ${who}, then open “${safe(name)}” for comments and live collaboration.`;
  } else if (action === "duplicate") {
    title = "Start from this";
    desc = `Copy “${safe(name)}” to a new file—original stays unchanged. (Demo)`;
  } else {
    title = "New design";
    desc = `Blank canvas instead of “${safe(name)}”. (Demo)`;
  }
  matchModalTitle.textContent = title;
  matchModalDesc.textContent = desc;
  const collabBtn = document.getElementById("match-modal-collab");
  if (collabBtn) {
    collabBtn.hidden = action === "collab";
  }
  matchModal.hidden = false;
}

document.getElementById("match-modal-collab")?.addEventListener("click", () => {
  if (!modalContextAsset) return;
  openMatchActionModal("collab", modalContextAsset);
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
  const sma = document.getElementById("smart-match-alert");
  if (sma && !sma.hidden) {
    closeSmartMatchAlert();
    return;
  }
  if (matchModal && !matchModal.hidden) closeMatchModal();
});

document.querySelectorAll("[data-home-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.getAttribute("data-home-tab");
    if (tab) setHomeView(tab);
  });
});

document.querySelectorAll("[data-nav-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.getAttribute("data-nav-tab");
    if (tab) setHomeView(tab);
  });
});

document.getElementById("nav-rail-home")?.addEventListener("click", () => {
  setHomeView("designs");
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
  if (!text) {
    description.focus();
    return;
  }

  scanBtn.disabled = true;
  scanHint.hidden = false;
  scanHint.textContent = "Matching your brief to the workspace…";
  matchSection.hidden = true;
  toast.hidden = true;

  try {
    const result = await matchWithApi(text);
    if (result.warning) {
      showToast(result.warning);
    }
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
    setModelBadge("error", "Match failed · see message");
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
  setHomeView("designs");
})();
