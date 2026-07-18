import { describe, expect, it } from "vitest";
import {
  canRetryMutationAfterError,
  formatUnknownError,
  isContentFilterError,
} from "../src/providers/backoff.js";
import { openRouterFallbackChain } from "../src/providers/index.js";

describe("formatUnknownError", () => {
  it("reads nested OpenRouter-style objects", () => {
    expect(
      formatUnknownError({
        code: 502,
        message: "Upstream error from Alibaba: Output data may contain inappropriate content.",
      })
    ).toContain("inappropriate content");
  });
});

describe("isContentFilterError", () => {
  it("matches Alibaba inappropriate-content errors", () => {
    expect(
      isContentFilterError({
        message:
          "Upstream error from Alibaba: Output data may contain inappropriate content. For details, see: https://example.com",
      })
    ).toBe(true);
  });

  it("rejects generic provider failures", () => {
    expect(isContentFilterError(new Error("The model provider could not complete this request."))).toBe(
      false
    );
  });
});

describe("openRouterFallbackChain", () => {
  const env = {
    LLM_PROVIDER: "openrouter",
    LLM_MODEL: "qwen/qwen3.7-plus",
    OPENROUTER_API_KEY: "sk-test",
    OPENROUTER_MODELS:
      "qwen/qwen3.7-plus,google/gemini-2.5-flash,deepseek/deepseek-v4-pro,anthropic/claude-sonnet-4",
  };

  it("starts at LLM_MODEL then walks OPENROUTER_MODELS", () => {
    expect(openRouterFallbackChain({}, env)).toEqual([
      "qwen/qwen3.7-plus",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-v4-pro",
      "anthropic/claude-sonnet-4",
    ]);
  });

  it("honors an explicit model with no further backoff", () => {
    expect(openRouterFallbackChain({ model: "deepseek/deepseek-v4-pro" }, env)).toEqual([
      "deepseek/deepseek-v4-pro",
    ]);
  });

  it("returns empty for non-openrouter so callers use resolveModel directly", () => {
    expect(
      openRouterFallbackChain(
        {},
        {
          LLM_PROVIDER: "llamacpp",
          LLM_MODEL: "",
          LLAMACPP_BASE_URL: "http://localhost:8080",
          OPENROUTER_MODELS: "qwen/qwen3.7-plus,deepseek/deepseek-v4-pro",
        }
      )
    ).toEqual([]);
  });

  it("does not borrow openrouter default when selecting another provider", () => {
    expect(
      openRouterFallbackChain(
        { provider: "llamacpp" },
        {
          LLM_PROVIDER: "openrouter",
          LLM_MODEL: "qwen/qwen3.7-plus",
          OPENROUTER_API_KEY: "sk-test",
          LLAMACPP_BASE_URL: "http://localhost:8080",
        }
      )
    ).toEqual([]);
  });
});

describe("canRetryMutationAfterError", () => {
  it("blocks retry after a write was attempted even if filesChanged is empty", () => {
    expect(canRetryMutationAfterError(0, false)).toBe(true);
    expect(canRetryMutationAfterError(0, true)).toBe(false);
    expect(canRetryMutationAfterError(2, false)).toBe(false);
  });
});
