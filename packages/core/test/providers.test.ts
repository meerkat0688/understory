import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { discoverLlamaCppModel } from "../src/providers/index.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

// Each test uses its own base URL — discovery is cached per URL, and the
// cache is module-level state shared across tests in this file.
let counter = 0;
function freshBaseURL() {
  return `http://localhost:${8080 + counter++}`;
}

describe("discoverLlamaCppModel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("prefers the model llama-swap reports as loaded", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "model-a", status: { value: "unloaded" } },
          { id: "model-b", status: { value: "loaded" } },
        ],
      })
    );
    await expect(discoverLlamaCppModel(freshBaseURL())).resolves.toBe("model-b");
  });

  it("does not re-fetch within the TTL window", async () => {
    const url = freshBaseURL();
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ data: [{ id: "model-a" }] }));
    await discoverLlamaCppModel(url);
    await discoverLlamaCppModel(url);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-checks the loaded model again after the TTL expires", async () => {
    const url = freshBaseURL();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-a" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-b" }] }));

    await expect(discoverLlamaCppModel(url)).resolves.toBe("model-a");
    vi.advanceTimersByTime(61_000);
    await expect(discoverLlamaCppModel(url)).resolves.toBe("model-b");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed discovery", async () => {
    const url = freshBaseURL();
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-a" }] }));

    await expect(discoverLlamaCppModel(url)).rejects.toThrow();
    await expect(discoverLlamaCppModel(url)).resolves.toBe("model-a");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("openRouterModels", () => {
  it("parses OPENROUTER_MODELS and prepends LLM_MODEL when missing", async () => {
    const { openRouterModels } = await import("../src/providers/index.js");
    expect(
      openRouterModels({
        LLM_PROVIDER: "openrouter",
        LLM_MODEL: "qwen/qwen3.7-plus",
        OPENROUTER_API_KEY: "sk-test",
        OPENROUTER_MODELS: "google/gemini-2.5-flash,deepseek/deepseek-v4-flash",
      })
    ).toEqual([
      "qwen/qwen3.7-plus",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-v4-flash",
    ]);
  });

  it("does not duplicate LLM_MODEL when already listed", async () => {
    const { openRouterModels } = await import("../src/providers/index.js");
    expect(
      openRouterModels({
        LLM_PROVIDER: "openrouter",
        LLM_MODEL: "qwen/qwen3.7-plus",
        OPENROUTER_API_KEY: "sk-test",
        OPENROUTER_MODELS: "qwen/qwen3.7-plus,anthropic/claude-sonnet-4",
      })
    ).toEqual(["qwen/qwen3.7-plus", "anthropic/claude-sonnet-4"]);
  });
});
