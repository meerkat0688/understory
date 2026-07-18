import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  extractOpenRouterCostUsd,
  loadLlmPricing,
} from "../src/providers/pricing.js";

describe("estimateCostUsd", () => {
  it("returns null when pricing is unset", () => {
    expect(
      estimateCostUsd(
        { inputTokens: 1000, outputTokens: 500 },
        { inputUsdPerMTok: null, outputUsdPerMTok: null }
      )
    ).toBeNull();
  });

  it("prices Qwen-style rates for a knowledge turn", () => {
    const cost = estimateCostUsd(
      { inputTokens: 50_000, outputTokens: 5_000 },
      { inputUsdPerMTok: 0.32, outputUsdPerMTok: 1.28 }
    );
    // 50k * 0.32/1M + 5k * 1.28/1M = 0.016 + 0.0064
    expect(cost).toBeCloseTo(0.0224, 6);
  });
});

describe("loadLlmPricing", () => {
  it("reads env rates", () => {
    expect(
      loadLlmPricing({
        LLM_INPUT_USD_PER_MTOK: "0.32",
        LLM_OUTPUT_USD_PER_MTOK: "1.28",
      })
    ).toEqual({ inputUsdPerMTok: 0.32, outputUsdPerMTok: 1.28 });
  });
});

describe("extractOpenRouterCostUsd", () => {
  it("reads billed cost from OpenRouter provider metadata", () => {
    expect(
      extractOpenRouterCostUsd({
        openrouter: { usage: { cost: 0.0042, totalTokens: 1200 } },
      })
    ).toBe(0.0042);
  });

  it("returns null when cost is missing", () => {
    expect(extractOpenRouterCostUsd({ openrouter: { usage: {} } })).toBeNull();
    expect(extractOpenRouterCostUsd(undefined)).toBeNull();
  });
});
