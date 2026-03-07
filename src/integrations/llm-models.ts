export const DEFAULT_MINIMAX_MODEL = "MiniMax-M2.5";

export const STANDARD_MINIMAX_MODELS = ["MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2"] as const;

export const HIGHSPEED_MINIMAX_MODELS = ["MiniMax-M2.5-highspeed", "MiniMax-M2.1-highspeed"] as const;

export const SUPPORTED_MINIMAX_MODELS = [...STANDARD_MINIMAX_MODELS, ...HIGHSPEED_MINIMAX_MODELS] as const;

const HIGHSPEED_FALLBACKS: Record<string, string> = {
  "MiniMax-M2.5-highspeed": "MiniMax-M2.5",
  "MiniMax-M2.1-highspeed": "MiniMax-M2.1",
};

export function validateMinimaxModel(model: string): string {
  const normalized = model.trim();
  if ((SUPPORTED_MINIMAX_MODELS as readonly string[]).includes(normalized)) {
    return normalized;
  }

  throw new Error(
    `Unsupported MiniMax model '${model}'. Supported models: ${SUPPORTED_MINIMAX_MODELS.join(", ")}.`,
  );
}

export function resolveLlmModel(cliModel: string | undefined): string {
  const candidate = cliModel ?? process.env.SPEC_LLM_MODEL ?? process.env.AHENTE_LLM_MODEL;
  if (!candidate) {
    return DEFAULT_MINIMAX_MODEL;
  }
  return validateMinimaxModel(candidate);
}

export function fallbackModelForPlan(model: string): string | undefined {
  return HIGHSPEED_FALLBACKS[model];
}

export function isUnsupportedModelError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("not support model") || lower.includes("unsupported model") || lower.includes("(2061)") || lower.includes("code: 2061");
}
