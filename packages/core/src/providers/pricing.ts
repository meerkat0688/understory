/** USD per 1M tokens — set via env so cost estimates match the model you actually run. */
export interface LlmPricing {
  inputUsdPerMTok: number | null;
  outputUsdPerMTok: number | null;
}

export interface TokenUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
}

export type CostSource = "provider" | "estimate";

function nonNegativeNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function loadLlmPricing(env: NodeJS.ProcessEnv = process.env): LlmPricing {
  return {
    inputUsdPerMTok: nonNegativeNumber(env.LLM_INPUT_USD_PER_MTOK),
    outputUsdPerMTok: nonNegativeNumber(env.LLM_OUTPUT_USD_PER_MTOK),
  };
}

/** Returns null when pricing env vars are unset or usage has no token counts. */
export function estimateCostUsd(usage: TokenUsage, pricing: LlmPricing): number | null {
  if (pricing.inputUsdPerMTok == null || pricing.outputUsdPerMTok == null) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (input <= 0 && output <= 0) return null;
  return (input / 1_000_000) * pricing.inputUsdPerMTok + (output / 1_000_000) * pricing.outputUsdPerMTok;
}

/**
 * OpenRouter (and compatible providers) attach billed USD in
 * providerMetadata.openrouter.usage.cost on each model step.
 */
export function extractOpenRouterCostUsd(
  providerMetadata: Record<string, unknown> | undefined
): number | null {
  if (!providerMetadata) return null;
  const openrouter = providerMetadata.openrouter;
  if (!openrouter || typeof openrouter !== "object") return null;
  const usage = (openrouter as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const cost = (usage as { cost?: unknown }).cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}
