/**
 * System prompt for Smart Match (Canva Teams) — user message is built from workspace assets.
 */

export const SMART_MATCH_SYSTEM = `You are Smart Match, an AI layer inside Canva Teams that prevents duplicate work.

Your response must be a single JSON object with exactly one key "matches" whose value is an array.
Each array element must have: id (string), confidence (integer 0-100), reasoning (one sentence to the user), matchSignals (array of strings from: "semantic", "visual", "color", "keyword").

Order matches by confidence (highest first). Include every workspace asset that is plausibly relevant so the user can compare — strong matches and weaker “maybe” ties are both OK. Do not apply a minimum confidence cutoff. If nothing in the list relates at all, return an empty array.`;

/**
 * @param {string} description
 * @param {object[]} assets normalized workspace rows
 */
export function buildUserPrompt(description, assets) {
  const block = assets
    .map((a) => {
      const ann =
        Array.isArray(a.annotations) && a.annotations.length
          ? `\nAnnotated layout: ${a.annotations.map((x, i) => `${i + 1}. ${x}`).join(" ")}`
          : "";
      return `ID: ${a.id}
Name: ${a.name}
Description: ${a.description}
Tags: ${(a.tags || []).join(", ")}
Dominant colors: ${(a.dominantColors || []).join(", ")}
Visual content: ${a.clipDescription || "(none)"}${ann}
Owner: ${a.owner}
Status: ${a.status}`;
    })
    .join("\n---\n");

  return `WHAT THEY WANT TO MAKE:
${JSON.stringify(description)}

EXISTING WORKSPACE ASSETS:
${block}

MATCHING INSTRUCTIONS:
Evaluate each asset across four signals:
1. Semantic similarity — does the creative intent match even if the words are different
2. Keyword overlap — do the tags, names, or descriptions share relevant terms
3. Color palette — does the user's description imply a mood or color that matches
4. Visual content — does what's physically in the design match what they're trying to make

Weight the signals based on what the user emphasized. If they mention colors, weight color higher. If they describe a campaign or format, weight semantic and visual higher.

Return every asset that could help them spot duplicate or related work, ordered by confidence (highest first). Use the full 0–100 range; weaker matches can be in the 20–40 range if still somewhat related. Omit assets only when there is essentially no connection.

Return JSON only in this shape (no markdown, no explanation outside JSON):
{"matches":[{"id":"asset id","confidence":87,"reasoning":"One sentence written directly to the user explaining why this is a match","matchSignals":["semantic","visual","color","keyword"]}]}`;
}
