import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export type ProviderName = "anthropic" | "openrouter" | "local";

export interface ProviderConfig {
  /** Default provider, from LLM_PROVIDER env. */
  provider: ProviderName;
  /** Default model id for that provider, from LLM_MODEL env. */
  model: string;
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-5",
  openrouter: "anthropic/claude-sonnet-5",
  local: "local-model",
};

export function loadProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const provider = (env.LLM_PROVIDER ?? "anthropic") as ProviderName;
  if (!["anthropic", "openrouter", "local"].includes(provider)) {
    throw new Error(`Unknown LLM_PROVIDER "${env.LLM_PROVIDER}" (anthropic|openrouter|local)`);
  }
  return { provider, model: env.LLM_MODEL ?? DEFAULT_MODELS[provider] };
}

/** Providers the current env has credentials/config for (drives the UI picker). */
export function availableProviders(env: NodeJS.ProcessEnv = process.env): ProviderName[] {
  const out: ProviderName[] = [];
  if (env.ANTHROPIC_API_KEY) out.push("anthropic");
  if (env.OPENROUTER_API_KEY) out.push("openrouter");
  if (env.LOCAL_BASE_URL) out.push("local");
  return out;
}

export function resolveModel(
  provider?: ProviderName,
  model?: string,
  env: NodeJS.ProcessEnv = process.env
): LanguageModel {
  const config = loadProviderConfig(env);
  const p = provider ?? config.provider;
  const m = model ?? (provider && provider !== config.provider ? DEFAULT_MODELS[p] : config.model);

  switch (p) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
      return anthropic(m);
    }
    case "openrouter": {
      const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
      return openrouter.chat(m);
    }
    case "local": {
      const local = createOpenAICompatible({
        name: "local",
        baseURL: env.LOCAL_BASE_URL ?? "http://localhost:8080/v1",
        apiKey: env.LOCAL_API_KEY ?? "not-needed",
      });
      return local(m);
    }
  }
}
