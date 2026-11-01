import { describe, expect, it } from "vitest";

import {
  type Draft,
  type DraftModel,
  type SavedCatalog,
  addModels,
  draftProblems,
  fromListed,
  parsePrice,
  removeModel,
  reroute,
  riskyModelNames,
  toDraft,
  togglePriceMode,
  toSaveBody,
} from "./catalog-draft";
import { riskyPriceModelIds } from "./platform-models";

const row = (overrides: Partial<DraftModel> = {}): DraftModel => ({
  id: "m",
  name: "M",
  vendor: "acme",
  provider: "openrouter",
  providerModelId: "acme/m",
  vision: false,
  tools: "reported",
  access: "everyone",
  hidden: false,
  priceMode: "blended",
  price: "8",
  input: "",
  output: "",
  ...overrides,
});

const draftOf = (models: DraftModel[], ids: Partial<Draft> = {}): Draft => ({
  models,
  defaultModelId: models[0]?.id ?? "",
  utilityModelId: models[0]?.id ?? "",
  ...ids,
});

describe("catalog draft", () => {
  it("never treats an empty or out-of-range price as a price", () => {
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("-1")).toBeNull();
    expect(parsePrice("1001")).toBeNull();
    expect(parsePrice("abc")).toBeNull();
    expect(parsePrice("0")).toBe(0);
  });

  it("blocks save on missing prices, unconfirmed tools and an ineligible default or utility", () => {
    expect(draftProblems(draftOf([]))).toEqual(["Add at least one model"]);
    expect(
      draftProblems(
        draftOf(
          [
            row({ id: "a", price: "" }),
            row({ id: "b", tools: null }),
            row({ id: "c", priceMode: "split", input: "1", output: "" }),
            row({ id: "promo", access: "promo_counted" }),
          ],
          { defaultModelId: "promo", utilityModelId: "promo" },
        ),
      ),
    ).toEqual([
      "Set valid prices ($0–$1000) for 2 models",
      "Confirm tool calling for 1 model",
      "Pick a default model that everyone can use and isn't hidden",
      "Pick a utility model that everyone can use",
    ]);
    expect(draftProblems(draftOf([row({ hidden: true })]))).toEqual([
      "Pick a default model that everyone can use and isn't hidden",
    ]);
    expect(draftProblems(draftOf([row()]))).toEqual([]);
  });

  it("prefills OpenRouter's own price blended, else the reference price marked as such", () => {
    const own = fromListed(
      { id: "a/b", name: "B", vendor: "a", vision: true, tools: true, inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
      "openrouter",
    );
    expect(own).toMatchObject({ id: "a/b", providerModelId: "a/b", price: "8", isReferencePrice: false, vision: true });

    const reference = fromListed(
      { id: "claude-x", name: "Claude X", vendor: "anthropic", vision: false, tools: true, referencePrice: 6 },
      "anthropic",
    );
    expect(reference).toMatchObject({ price: "6", isReferencePrice: true, access: "everyone", hidden: false });

    const unknown = fromListed({ id: "gpt-x", name: "gpt-x", vendor: "openai", vision: null, tools: null }, "openai");
    expect(unknown).toMatchObject({ price: "", isReferencePrice: false, tools: null, vision: false });
  });

  it("re-routes keeping the stable id, name and access", () => {
    const model = row({ id: "anthropic/claude-opus", access: "promo_counted", vision: true });
    const moved = reroute(model, "anthropic", {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      vendor: "anthropic",
      vision: true,
      tools: true,
      referencePrice: 10,
    });
    expect(moved).toMatchObject({
      id: "anthropic/claude-opus",
      name: "M",
      access: "promo_counted",
      provider: "anthropic",
      providerModelId: "claude-opus-5-5",
      vision: false,
      price: "10",
      isReferencePrice: true,
    });
  });

  it("toggles Advanced pricing without losing the price", () => {
    const split = togglePriceMode(row({ price: "8" }));
    expect(split).toEqual({ priceMode: "split", input: "8", output: "8" });
    expect(togglePriceMode(row({ priceMode: "split", input: "4", output: "20" }))).toEqual({
      priceMode: "blended",
      price: "8",
    });
  });

  it("adds new rows only and fills an empty default and utility", () => {
    const listed = [
      { id: "x", name: "X", vendor: "v", vision: false, tools: true },
      { id: "y", name: "Y", vendor: "v", vision: false, tools: true },
    ];
    const once = addModels(draftOf([]), "groq", listed);
    expect(once.models.map((m) => m.id)).toEqual(["x", "y"]);
    expect(once).toMatchObject({ defaultModelId: "x", utilityModelId: "x" });
    expect(addModels(once, "groq", listed).models).toHaveLength(2);
  });

  it("moves the default and utility off a removed model to the first eligible one", () => {
    const draft = draftOf([row({ id: "a" }), row({ id: "p", access: "promo_unlimited" }), row({ id: "b" })]);
    expect(removeModel(draft, "a")).toMatchObject({ defaultModelId: "b", utilityModelId: "b" });
    expect(removeModel(draft, "b")).toMatchObject({ defaultModelId: "a", utilityModelId: "a" });
  });

  it("serializes the save body with numeric pricing and confirmed tools", () => {
    const body = toSaveBody(
      draftOf([
        row({ id: "a", tools: null, contextLength: 131072, isReferencePrice: true }),
        row({ id: "b", priceMode: "split", input: "0.59", output: "0.79" }),
      ]),
      true,
    );
    expect(body).toEqual({
      defaultModelId: "a",
      utilityModelId: "a",
      confirmRiskyPrices: true,
      models: [
        {
          id: "a",
          name: "M",
          vendor: "acme",
          provider: "openrouter",
          providerModelId: "acme/m",
          contextLength: 131072,
          vision: false,
          tools: "confirmed",
          pricing: { mode: "blended", usdPerMTok: 8 },
          access: "everyone",
          hidden: false,
        },
        {
          id: "b",
          name: "M",
          vendor: "acme",
          provider: "openrouter",
          providerModelId: "acme/m",
          vision: false,
          tools: "reported",
          pricing: { mode: "split", inputUsdPerMTok: 0.59, outputUsdPerMTok: 0.79 },
          access: "everyone",
          hidden: false,
        },
      ],
    });
  });

  it("round-trips a saved catalog through the draft", () => {
    const saved: SavedCatalog = toSaveBody(
      draftOf([row({ id: "a" }), row({ id: "b", priceMode: "split", input: "1", output: "2" })]),
      false,
    );
    expect(toSaveBody(toDraft(saved), false)).toEqual({ ...saved, confirmRiskyPrices: false });
  });
});

describe("risky prices", () => {
  it("flags a new or changed $0 and a move of more than half the saved price", () => {
    const priced = (id: string, usdPerMTok: number) => ({
      id,
      pricing: { mode: "blended" as const, usdPerMTok },
    });
    const saved = [priced("free", 0), priced("ten", 10), priced("four", 4)];
    expect(
      riskyPriceModelIds(saved, [
        priced("free", 0), // unchanged $0: no prompt
        priced("ten", 15), // +50%: fine
        priced("four", 0), // now free
        priced("new", 0), // new and free
        priced("new2", 3), // new and priced
      ]),
    ).toEqual(["four", "new"]);
    expect(riskyPriceModelIds(saved, [priced("ten", 15.01)])).toEqual(["ten"]);
    expect(riskyPriceModelIds(saved, [priced("ten", 4.99)])).toEqual(["ten"]);
  });

  it("flags a big move in either split price even when the blend holds", () => {
    const split = (inputUsdPerMTok: number, outputUsdPerMTok: number) => [
      { id: "s", pricing: { mode: "split" as const, inputUsdPerMTok, outputUsdPerMTok } },
    ];
    expect(riskyPriceModelIds(split(4, 20), split(8, 8))).toEqual(["s"]); // both $8 blended
    expect(riskyPriceModelIds(split(4, 20), split(5, 25))).toEqual([]);
  });

  it("names the draft's risky models against the saved catalog, by blended price", () => {
    const saved = toSaveBody(draftOf([row({ id: "a", price: "8" }), row({ id: "b", price: "8" })]), false);
    const draft = draftOf([
      row({ id: "a", name: "A", priceMode: "split", input: "4", output: "20" }), // still $8 blended
      row({ id: "b", name: "B", price: "20" }),
      row({ id: "c", name: "C", price: "0" }),
    ]);
    expect(riskyModelNames(draft, saved)).toEqual(["B", "C"]);
  });
});
