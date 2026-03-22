/**
 * Smart Match API — Anthropic Claude (prompt in lib/smartmatch-prompt.mjs) or local 4-signal fallback.
 */
import dotenv from "dotenv";
import express from "express";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { SMART_MATCH_SYSTEM, buildUserPrompt } from "./lib/smartmatch-prompt.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });

const PORT = Number(process.env.PORT) || 3000;
const DATA_PATH = join(__dirname, "data", "workspace.json");
const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Trim + strip accidental quotes from .env */
function anthropicApiKey() {
  const raw = process.env.ANTHROPIC_API_KEY;
  if (!raw || typeof raw !== "string") return "";
  return raw.trim().replace(/^["']|["']$/g, "");
}

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(express.static(__dirname));

const rawAssets = JSON.parse(readFileSync(DATA_PATH, "utf8"));

/** @typedef {{ id: string, name: string, description: string, tags: string[], dominantColors: string[], clipDescription: string, owner: string, status: string, thumbnail: string, annotations: string[], designFormat: string }} NormalizedAsset */

/**
 * Human-readable format for UI (Instagram post, Story, flyer, poster, site, etc.).
 * Uses explicit JSON `designFormat` when set; otherwise infers from name/tags/description.
 * @param {object} a
 */
function inferDesignFormat(a) {
  const explicit = a.designFormat != null ? String(a.designFormat).trim() : "";
  if (explicit) return explicit;

  const name = String(a.name || "").toLowerCase();
  const desc = String(a.description || "").toLowerCase();
  const tags = Array.isArray(a.tags) ? a.tags.map((t) => String(t).toLowerCase()) : [];
  const blob = `${name} ${desc} ${tags.join(" ")}`;

  if (/instagram|insta\b|\big post\b/.test(blob) && /story/.test(blob)) return "Instagram story";
  if (/instagram|insta\b/.test(blob)) return "Instagram post";
  if (/\bstory\b/.test(name) && /(social|square|vertical|feed)/.test(blob)) return "Instagram story";
  if (/(landing|website|web page|site\.|homepage|hero.*nav|online agency)/.test(blob)) return "Site / landing page";
  if (/boarding pass|ticket stub|pass template/.test(blob)) return "Print — ticket";
  if (/(^|[^a-z])slide([^a-z]|$)|deck|presentation|page \d/.test(blob)) return "Presentation slide";
  if (/logo|wordmark|brand mark/.test(blob) && !/flyer|poster|menu|banner|slide/.test(blob)) return "Logo / brand";
  if (/menu|price list|special coffee|drinks row/.test(blob)) return "Menu";
  if (/banner|square ad|vertical ad/.test(blob)) return "Banner / ad";
  if (/square|social( |$)|food delivery square|promo/.test(blob) && /social|discount|order now/.test(blob))
    return "Social post";
  if (/flyer|leaflet|parcel|delivered/.test(blob) && /flyer/.test(blob)) return "Flyer";
  if (/flyer/.test(blob)) return "Flyer";
  if (/poster|aviation poster|academy/.test(blob)) return "Poster";
  if (/email|newsletter|mailing/.test(blob)) return "Email";
  return "Design";
}

/** @param {object} a */
function normalizeAsset(a) {
  const base = {
    id: String(a.id),
    name: a.name ?? a.title ?? "Untitled",
    description: a.description ?? a.text ?? "",
    tags: Array.isArray(a.tags) ? a.tags.map(String) : [],
    dominantColors: Array.isArray(a.dominantColors) ? a.dominantColors.map(String) : [],
    clipDescription: a.clipDescription != null ? String(a.clipDescription) : "",
    owner: a.owner != null ? String(a.owner) : "",
    status: a.status != null ? String(a.status) : "",
    thumbnail: a.thumbnail != null ? String(a.thumbnail) : "",
    annotations: Array.isArray(a.annotations) ? a.annotations.map(String) : [],
  };
  return {
    ...base,
    designFormat: inferDesignFormat({ ...base, designFormat: a.designFormat }),
  };
}

const assets = rawAssets.map(normalizeAsset);

/** Workspace rows that belong to the shared template library (match targets for “Your designs”). */
function isTemplateLibraryAsset(a) {
  const s = String(a.status || "").toLowerCase();
  return s.includes("template");
}

let extractor = null;
let embeddingError = null;
let matchMode = "none";

/** @type {(NormalizedAsset & { vecMain: Float32Array, vecClip: Float32Array, tokenBlob: Set<string> })[]} */
let indexed = [];

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function tokenSetForKeyword(a) {
  const blob = [a.name, a.description, ...(a.tags || []), ...(a.annotations || [])].join(" ");
  return new Set(tokenize(blob));
}

function jaccardSimilarity(qTokens, docTokens) {
  if (qTokens.size === 0 && docTokens.size === 0) return 0;
  let inter = 0;
  for (const t of qTokens) {
    if (docTokens.has(t)) inter++;
  }
  const union = qTokens.size + docTokens.size - inter;
  return union ? inter / union : 0;
}

function toVector(output) {
  if (output == null) throw new Error("Empty model output");
  if (output instanceof Float32Array) return output;
  const raw = output?.data !== undefined ? output.data : output;
  if (raw instanceof Float32Array) return raw;
  if (raw instanceof Float64Array) return Float32Array.from(raw);
  if (ArrayBuffer.isView(raw)) {
    const len = raw.byteLength / Float32Array.BYTES_PER_ELEMENT;
    return new Float32Array(raw.buffer, raw.byteOffset, len);
  }
  if (typeof output?.tolist === "function") {
    return Float32Array.from(output.tolist().flat(Infinity).map(Number));
  }
  if (Array.isArray(raw)) return Float32Array.from(raw.flat(Infinity));
  throw new Error("Cannot parse embedding");
}

function cosineDot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function toConfidence(cosine) {
  return Math.max(0, Math.min(1, (cosine + 1) / 2));
}

const COLOR_WORDS = /\b(red|blue|green|teal|purple|pink|orange|yellow|black|white|gray|grey|navy|cyan|pastel|neon|gold|cream|beige|coral|magenta|violet|gradient|muted|bright|dark|light|sunset|warm|cool)\b/i;

function colorOverlapScore(query, asset) {
  const dc = (asset.dominantColors || []).join(" ").toLowerCase();
  if (!dc.length) return 0.5;
  const qTokens = tokenize(query);
  let hits = 0;
  for (const t of qTokens) {
    if (t.length > 2 && dc.includes(t)) hits++;
  }
  if (hits === 0 && COLOR_WORDS.test(query)) {
    return 0.42;
  }
  return Math.min(1, 0.38 + 0.14 * Math.min(hits, 5));
}

function weightsForQuery(q) {
  const colorEmphasis = COLOR_WORDS.test(q) || /\b(color|palette|hue|tone|brand|gradient)\b/i.test(q);
  const formatEmphasis = /\b(story|banner|slide|deck|flyer|email|landing|linkedin|instagram|print|video|hero|presentation|webinar|A5|A4)\b/i.test(q);
  if (colorEmphasis && !formatEmphasis) {
    return { semantic: 0.25, keyword: 0.2, color: 0.35, visual: 0.2 };
  }
  if (formatEmphasis) {
    return { semantic: 0.38, keyword: 0.2, color: 0.12, visual: 0.3 };
  }
  return { semantic: 0.34, keyword: 0.24, color: 0.16, visual: 0.26 };
}

function rankSignals(sem, key, col, vis, w) {
  const contrib = [
    ["semantic", sem * w.semantic],
    ["keyword", key * w.keyword],
    ["color", col * w.color],
    ["visual", vis * w.visual],
  ];
  contrib.sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [name, score] of contrib) {
    if (score >= 0.12 && out.length < 4) out.push(name);
  }
  if (!out.length) out.push(contrib[0][0]);
  return out;
}

async function loadEmbeddings() {
  embeddingError = null;
  const cacheDir = join(__dirname, ".cache", "hf");
  mkdirSync(cacheDir, { recursive: true });
  const { pipeline, env } = await import("@xenova/transformers");
  env.cacheDir = cacheDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  console.log(`Loading ${EMBED_MODEL}…`);
  extractor = await pipeline("feature-extraction", EMBED_MODEL);

  indexed = [];
  for (const a of assets) {
    const ann = (a.annotations || []).join(". ");
    const mainBlob = [a.name, a.description, ...(a.tags || []), ann].filter(Boolean).join(". ");
    const clipBlob = [a.clipDescription || a.description].filter(Boolean).join(". ");
    const outMain = await extractor(mainBlob, { pooling: "mean", normalize: true });
    const outClip = await extractor(clipBlob, { pooling: "mean", normalize: true });
    indexed.push({
      ...a,
      vecMain: toVector(outMain),
      vecClip: toVector(outClip),
      tokenBlob: tokenSetForKeyword(a),
    });
  }
  console.log(`Indexed ${indexed.length} assets (embeddings).`);
  matchMode = "embedding";
}

async function ensureEmbeddings() {
  if (matchMode === "embedding" && extractor && indexed.length === assets.length) return;
  try {
    await loadEmbeddings();
  } catch (e) {
    embeddingError = e?.message ?? String(e);
    console.error("Embeddings failed:", embeddingError);
    extractor = null;
    indexed = [];
    matchMode = "none";
  }
}

/**
 * Local matcher: four signals → confidence 0–100, all assets ranked.
 * @param {string} query
 */
async function matchLocalFourSignals(query) {
  await ensureEmbeddings();
  const qTokens = new Set(tokenize(query));
  const w = weightsForQuery(query);

  let qVecMain = null;
  let qVecClip = null;
  if (extractor && indexed.length) {
    const qo = await extractor(query, { pooling: "mean", normalize: true });
    qVecMain = qVecClip = toVector(qo);
  }

  const results = [];

  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    const row = indexed[i];

    let semantic = 0.35;
    let visual = 0.35;
    let keyword = jaccardSimilarity(qTokens, row ? row.tokenBlob : tokenSetForKeyword(a));
    let color = colorOverlapScore(query, a);

    if (row && qVecMain) {
      semantic = toConfidence(cosineDot(qVecMain, row.vecMain));
      visual = toConfidence(cosineDot(qVecClip, row.vecClip));
    } else {
      const blob = [a.name, a.description, ...(a.tags || [])].join(" ");
      semantic = jaccardSimilarity(qTokens, new Set(tokenize(blob)));
      visual = jaccardSimilarity(qTokens, new Set(tokenize(a.clipDescription || "")));
    }

    const combined = w.semantic * semantic + w.keyword * keyword + w.color * color + w.visual * visual;
    const confidence = Math.round(Math.min(100, Math.max(0, combined * 100)));

    const matchSignals = rankSignals(semantic, keyword, color, visual, w);
    const strength = confidence >= 55 ? "strong" : confidence >= 30 ? "some" : "light";
    const reasoning = `“${a.name}” has ${strength} overlap with your brief (${matchSignals.join(", ")}).`;
    const pct = (x) => Math.round(Math.min(100, Math.max(0, x * 100)));
    results.push({
      id: a.id,
      name: a.name,
      owner: a.owner,
      status: a.status,
      designFormat: a.designFormat || "Design",
      confidence,
      reasoning,
      matchSignals,
      thumbnail: a.thumbnail || "",
      annotations: a.annotations || [],
      signalScores: {
        semantic: pct(semantic),
        keyword: pct(keyword),
        color: pct(color),
        visual: pct(visual),
      },
    });
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return { matches: results, source: "local" };
}

/**
 * Compare one workspace asset (by id) to all *other* assets using the same four-signal blend.
 * Uses that asset’s embedding vectors + text as the synthetic “query” — no user typing.
 * @param {string} sourceAssetId
 * @param {{ templateOnly?: boolean }} [options]
 */
async function matchLocalFromAssetId(sourceAssetId, options = {}) {
  const templateOnly = options.templateOnly !== false;
  await ensureEmbeddings();
  const si = assets.findIndex((a) => a.id === sourceAssetId);
  if (si < 0) throw new Error("Unknown asset id");

  const src = assets[si];
  const srcRow = indexed[si];
  const query = [src.name, src.description, ...(src.tags || []), ...(src.annotations || [])].filter(Boolean).join(". ");
  const qTokens = new Set(tokenize(query));
  const w = weightsForQuery(query);

  let qVecMain = null;
  let qVecClip = null;
  if (srcRow && extractor) {
    qVecMain = srcRow.vecMain;
    qVecClip = srcRow.vecClip;
  } else if (extractor && indexed.length) {
    const qo = await extractor(query, { pooling: "mean", normalize: true });
    qVecMain = qVecClip = toVector(qo);
  }

  const results = [];
  const pct = (x) => Math.round(Math.min(100, Math.max(0, x * 100)));

  for (let j = 0; j < assets.length; j++) {
    if (j === si) continue;
    const a = assets[j];
    if (templateOnly && !isTemplateLibraryAsset(a)) continue;
    const srcIsInProgress = String(src.status || "").toLowerCase().includes("progress");
    if (
      templateOnly &&
      srcIsInProgress &&
      src.thumbnail &&
      a.thumbnail &&
      String(src.thumbnail).replace(/\\/g, "/").toLowerCase() === String(a.thumbnail).replace(/\\/g, "/").toLowerCase()
    ) {
      continue;
    }
    const row = indexed[j];

    let semantic = 0.35;
    let visual = 0.35;
    let keyword = jaccardSimilarity(qTokens, row ? row.tokenBlob : tokenSetForKeyword(a));
    let color = colorOverlapScore(query, a);

    if (row && qVecMain) {
      semantic = toConfidence(cosineDot(qVecMain, row.vecMain));
      visual = toConfidence(cosineDot(qVecClip, row.vecClip));
    } else {
      const blob = [a.name, a.description, ...(a.tags || [])].join(" ");
      semantic = jaccardSimilarity(qTokens, new Set(tokenize(blob)));
      visual = jaccardSimilarity(qTokens, new Set(tokenize(a.clipDescription || "")));
    }

    const combined = w.semantic * semantic + w.keyword * keyword + w.color * color + w.visual * visual;
    const confidence = Math.round(Math.min(100, Math.max(0, combined * 100)));

    const matchSignals = rankSignals(semantic, keyword, color, visual, w);
    const strength = confidence >= 55 ? "strong" : confidence >= 30 ? "some" : "light";
    const reasoning = `“${a.name}” has ${strength} overlap with “${src.name}” (${matchSignals.join(", ")}).`;
    results.push({
      id: a.id,
      name: a.name,
      owner: a.owner,
      status: a.status,
      designFormat: a.designFormat || "Design",
      confidence,
      reasoning,
      matchSignals,
      thumbnail: a.thumbnail || "",
      annotations: a.annotations || [],
      signalScores: {
        semantic: pct(semantic),
        keyword: pct(keyword),
        color: pct(color),
        visual: pct(visual),
      },
    });
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return { matches: results, source: "local-asset", sourceAssetId: sourceAssetId };
}

function parseJsonFromAssistant(text) {
  let t = String(text || "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Claude did not return valid JSON");
  }
}

async function matchClaude(description) {
  const userContent = buildUserPrompt(description, assets);
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": anthropicApiKey(),
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      temperature: 0.2,
      system: `${SMART_MATCH_SYSTEM}\n\nRespond with only a raw JSON object (no markdown, no code fences).`,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const block = data.content?.find((c) => c.type === "text");
  const content = block?.text;
  if (!content) throw new Error("Empty Claude response");

  const parsed = parseJsonFromAssistant(content);
  const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
  const byId = Object.fromEntries(assets.map((a) => [a.id, a]));
  const cleaned = matches
    .filter((m) => m && typeof m.id === "string")
    .map((m) => {
      const a = byId[m.id];
      const conf = Number(m.confidence);
      const confidence = Number.isFinite(conf)
        ? Math.min(100, Math.max(0, Math.round(conf)))
        : 0;
      return {
        id: m.id,
        name: a?.name,
        owner: a?.owner,
        status: a?.status,
        designFormat: a?.designFormat || "Design",
        confidence,
        reasoning: String(m.reasoning || ""),
        matchSignals: Array.isArray(m.matchSignals) ? m.matchSignals.map(String) : [],
        thumbnail: a?.thumbnail || "",
        annotations: Array.isArray(a?.annotations) ? a.annotations.map(String) : [],
      };
    })
    .filter((m) => byId[m.id])
    .sort((a, b) => b.confidence - a.confidence);

  return { matches: cleaned, source: "claude" };
}

app.get("/api/assets", (_req, res) => {
  res.json(
    assets.map((a) => ({
      id: a.id,
      name: a.name,
      title: a.name,
      owner: a.owner,
      status: a.status,
      designFormat: a.designFormat || "Design",
      thumbnail: a.thumbnail || undefined,
    })),
  );
});

app.get("/api/health", (_req, res) => {
  const key = anthropicApiKey();
  const hasKey = Boolean(key);
  res.json({
    ok: true,
    modelReady: assets.length > 0,
    assetCount: assets.length,
    llm: hasKey,
    anthropicModel: hasKey ? ANTHROPIC_MODEL : null,
    embeddings: matchMode === "embedding",
    embeddingDim: indexed[0]?.vecMain?.length ?? null,
    embeddingError: embeddingError || null,
    hint: hasKey ? null : "Set ANTHROPIC_API_KEY for Claude Smart Match; otherwise local 4-signal scoring is used.",
    envFileExists: existsSync(join(__dirname, ".env")),
  });
});

app.post("/api/match-from-asset", async (req, res) => {
  try {
    const assetId = String(req.body?.assetId ?? "").trim();
    if (!assetId) {
      res.status(400).json({ error: "Missing assetId", matches: [] });
      return;
    }
    if (!assets.some((a) => a.id === assetId)) {
      res.status(400).json({ error: "Unknown assetId", matches: [] });
      return;
    }
    const templateOnly = req.body?.templateOnly !== false;
    const out = await matchLocalFromAssetId(assetId, { templateOnly });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message ?? String(err), matches: [] });
  }
});

app.post("/api/match", async (req, res) => {
  try {
    const description = String(req.body?.query ?? req.body?.description ?? "").trim();
    if (!description) {
      res.status(400).json({ error: "Missing description" });
      return;
    }

    if (!assets.length) {
      res.status(400).json({ error: "No assets in data/workspace.json", matches: [] });
      return;
    }

    if (anthropicApiKey()) {
      try {
        const out = await matchClaude(description);
        res.json(out);
        return;
      } catch (e) {
        const msg = e?.message || String(e);
        console.error("Claude match failed, falling back:", msg);
        const out = await matchLocalFourSignals(description);
        res.json({ ...out, warning: `Claude failed (${msg.slice(0, 180)}). Using local scorer.` });
        return;
      }
    }

    const out = await matchLocalFourSignals(description);
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message ?? String(err), matches: [] });
  }
});

app.listen(PORT, async () => {
  console.log(`\n  Smart Match → http://localhost:${PORT}`);
  console.log("  ANTHROPIC_API_KEY:", anthropicApiKey() ? "set (Claude)" : "not set (local scoring)");
  console.log("  .env path:", join(__dirname, ".env"));
  console.log("");
  try {
    await loadEmbeddings();
  } catch (e) {
    embeddingError = e?.message ?? String(e);
    console.error("Embedding load failed (local matcher will use keyword proxies):", embeddingError);
  }
});
