import { blendPrices } from "../../ai-providers/catalog";
import type { ListedModel } from "../catalog-draft";
import type { FetchedModel } from "../platform-models";
import { normalizeProviderModels } from "./fetch-provider-models";

/**
 * Reference prices for providers whose models API has none (Anthropic, OpenAI,
 * Groq): OpenRouter's public price for the same model, matched by name. Only a
 * hint, marked "reference" in /admin; a miss or an OpenRouter outage leaves
 * the price for the admin to fill in.
 */

// Public: no key, so nothing of ours leaves with the request.
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 5_000;

const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** "Anthropic: Claude Opus 5.5" and "Claude Opus 5.5" → "claudeopus55". */
export const normalizeModelName = (name: string) => compact(name.replace(/^[^:]+:\s*/, ""));

/** "openai/gpt-oss-120b" and "gpt-oss-120b" → "gptoss120b". */
const idKey = (id: string) => compact(id.split("/").pop()!);

/**
 * Blended USD/1M from OpenRouter's rows, by normalized display name and id.
 * Free rows are left out: a $0 variant says nothing about a paid route.
 */
export function referencePriceIndex(models: FetchedModel[]): Map<string, number> {
  const index = new Map<string, number>();
  // A key two rows price differently is ambiguous: no hint beats a wrong one.
  const ambiguous = new Set<string>();
  for (const { id, name, inputUsdPerMTok: input, outputUsdPerMTok: output } of models) {
    if (input === undefined || output === undefined) continue;
    const price = Number(blendPrices(input, output).toFixed(6));
    if (price <= 0) continue;
    for (const key of [normalizeModelName(name), idKey(id)]) {
      if (!key) continue;
      const known = index.get(key);
      if (known === undefined) index.set(key, price);
      else if (known !== price) ambiguous.add(key);
    }
  }
  for (const key of ambiguous) index.delete(key);
  return index;
}

/** OpenRouter's price index, or an empty one when it can't be had. */
export async function fetchReferencePrices(): Promise<Map<string, number>> {
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return new Map();
    return referencePriceIndex(normalizeProviderModels("openrouter", await response.json()));
  } catch {
    // Best effort by design: no reference is the documented fallback.
    return new Map();
  }
}

export const withReferencePrices = (models: FetchedModel[], index: Map<string, number>): ListedModel[] =>
  models.map((model) => {
    const referencePrice = index.get(idKey(model.id)) ?? index.get(normalizeModelName(model.name));
    return referencePrice === undefined ? model : { ...model, referencePrice };
  });
