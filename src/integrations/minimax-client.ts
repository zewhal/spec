import { loadEnvironment } from "../config";
import { actionKinds, expectationKinds, waitTypes } from "../models/enums";
import {
  DEFAULT_MINIMAX_MODEL,
  SUPPORTED_MINIMAX_MODELS,
  fallbackModelForPlan,
  isUnsupportedModelError,
  validateMinimaxModel,
} from "./llm-models";

export class MiniMaxClientError extends Error {}

export type MiniMaxClientConfig = {
  model?: string;
  base_url?: string;
  api_key?: string;
  temperature?: number;
  reasoning_split?: boolean;
  max_attempts?: number;
  timeout_s?: number;
  auto_downgrade_highspeed?: boolean;
};

type ToolCallMessage = {
  role: string;
  content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
};

type ChatCompletionResponse = {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
  }>;
};

export class MiniMaxClient {
  readonly config: Required<MiniMaxClientConfig>;
  readonly onLlmCall?: (prompt: string, response: Record<string, unknown>) => void;

  constructor(config: MiniMaxClientConfig = {}, onLlmCall?: (prompt: string, response: Record<string, unknown>) => void) {
    loadEnvironment();
    const apiKey = config.api_key ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new MiniMaxClientError("OPENAI_API_KEY is required when LLM mode is enabled.");
    }

    try {
      this.config = {
        model: validateMinimaxModel(config.model ?? DEFAULT_MINIMAX_MODEL),
        base_url: process.env.OPENAI_BASE_URL ?? config.base_url ?? "https://api.minimax.io/v1",
        api_key: apiKey,
        temperature: config.temperature ?? 1.0,
        reasoning_split: config.reasoning_split ?? true,
        max_attempts: config.max_attempts ?? 2,
        timeout_s: config.timeout_s ?? 30,
        auto_downgrade_highspeed: config.auto_downgrade_highspeed ?? true,
      };
    } catch (error) {
      throw new MiniMaxClientError(error instanceof Error ? error.message : String(error));
    }

    this.onLlmCall = onLlmCall;
  }

  static fromConfig(config: MiniMaxClientConfig): MiniMaxClient {
    return new MiniMaxClient(config);
  }

  async normalizeStep(stepText: string): Promise<Record<string, unknown>> {
    return this.callToolWithRepair(
      [
        { role: "system", content: "You convert QA authoring steps into canonical action JSON. Always call the provided tool. Do not return plain text." },
        { role: "user", content: `Normalize this step into one canonical action with exact fields only: ${stepText}` },
      ],
      [this.actionToolSchema()],
      "emit_action",
    );
  }

  async normalizeExpectation(expectationText: string): Promise<Record<string, unknown>> {
    return this.callToolWithRepair(
      [
        { role: "system", content: "You convert QA expectation sentences into canonical expectation JSON. Always call the provided tool. Do not return plain text." },
        { role: "user", content: `Normalize this expectation into one canonical expectation with exact fields only: ${expectationText}` },
      ],
      [this.expectationToolSchema()],
      "emit_expectation",
    );
  }

  async extractTestOutline(testName: string, rawTestBlock: string): Promise<Record<string, unknown>> {
    return this.callToolWithRepair(
      [
        { role: "system", content: "You split free-form QA test text into two ordered lists: steps and expectations. Always call the tool." },
        { role: "user", content: `Test name: ${testName}\nExtract runnable step lines and expectation lines from this block:\n${rawTestBlock}` },
      ],
      [this.testOutlineToolSchema()],
      "emit_test_outline",
      ["steps", "expectations"],
    );
  }

  private async callToolWithRepair(
    messages: ToolCallMessage[],
    tools: Array<Record<string, unknown>>,
    toolName: string,
    requiredKeys: string[] = ["kind"],
  ): Promise<Record<string, unknown>> {
    let activeModel = this.config.model;

    for (let attempt = 1; attempt <= this.config.max_attempts; attempt += 1) {
      let response: ChatCompletionResponse;
      try {
        response = await this.createChatCompletion(activeModel, messages, tools, toolName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const fallback = this.resolveFallbackModel(activeModel, message);
        if (fallback) {
          activeModel = fallback;
          continue;
        }
        throw this.formatApiError(message, activeModel);
      }

      const message = response.choices[0]?.message;
      const toolCalls = message?.tool_calls ?? [];
      const selectedCall = toolCalls.find((call) => call.function.name === toolName);
      if (!selectedCall) {
        messages.push({ role: "assistant", content: message?.content ?? "", tool_calls: toolCalls });
        messages.push({
          role: "tool",
          tool_call_id: toolCalls[0]?.id ?? "missing-call",
          content: `Tool call missing or wrong function name. You must call \`${toolName}\` with valid JSON arguments.`,
        });
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(selectedCall.function.arguments) as Record<string, unknown>;
      } catch (error) {
        messages.push({ role: "assistant", content: message?.content ?? "", tool_calls: toolCalls });
        messages.push({
          role: "tool",
          tool_call_id: selectedCall.id,
          content: `Arguments were not valid JSON: ${error instanceof Error ? error.message : String(error)}. Return valid JSON only.`,
        });
        continue;
      }

      if (this.onLlmCall) {
        const prompt = messages.find((entry) => entry.role === "user")?.content ?? "";
        this.onLlmCall(prompt, args);
      }

      const missingKeys = requiredKeys.filter((key) => !(key in args));
      if (missingKeys.length > 0) {
        messages.push({ role: "assistant", content: message?.content ?? "", tool_calls: toolCalls });
        messages.push({
          role: "tool",
          tool_call_id: selectedCall.id,
          content: `Missing required fields: ${missingKeys.map((key) => `\`${key}\``).join(", ")}. Return corrected arguments.`,
        });
        continue;
      }

      return args;
    }

    throw new MiniMaxClientError(`MiniMax failed to produce valid \`${toolName}\` output after ${this.config.max_attempts} attempts.`);
  }

  private async createChatCompletion(
    model: string,
    messages: ToolCallMessage[],
    tools: Array<Record<string, unknown>>,
    toolName: string,
  ): Promise<ChatCompletionResponse> {
    const response = await fetch(`${this.config.base_url.replace(/\/$/u, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.api_key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        tool_choice: { type: "function", function: { name: toolName } },
        temperature: this.config.temperature,
        n: 1,
        extra_body: { reasoning_split: this.config.reasoning_split },
      }),
      signal: AbortSignal.timeout(this.config.timeout_s * 1000),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    return (await response.json()) as ChatCompletionResponse;
  }

  private resolveFallbackModel(activeModel: string, errorMessage: string): string | undefined {
    if (!this.config.auto_downgrade_highspeed) {
      return undefined;
    }
    if (!isUnsupportedModelError(errorMessage)) {
      return undefined;
    }
    return fallbackModelForPlan(activeModel);
  }

  private formatApiError(errorText: string, activeModel: string): MiniMaxClientError {
    if (isUnsupportedModelError(errorText)) {
      const fallback = fallbackModelForPlan(activeModel);
      if (fallback) {
        return new MiniMaxClientError(
          `Model '${activeModel}' is not available for this API key/plan. Try --llm-model ${fallback} or set AHENTE_LLM_MODEL=${fallback}. Provider error: ${errorText}`,
        );
      }
      return new MiniMaxClientError(
        `Model '${activeModel}' is not available for this API key/plan. Supported values: ${SUPPORTED_MINIMAX_MODELS.join(", ")}. Provider error: ${errorText}`,
      );
    }

    return new MiniMaxClientError(`MiniMax API call failed for model '${activeModel}'. Provider error: ${errorText}`);
  }

  private actionToolSchema(): Record<string, unknown> {
    return {
      type: "function",
      function: {
        name: "emit_action",
        description: "Emit exactly one canonical action object.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: actionKinds },
            url: { type: "string" },
            readiness: { type: "string" },
            readiness_text: { type: "string" },
            readiness_target: this.targetSchema(),
            target: this.targetSchema(),
            value: { type: "string" },
            append: { type: "boolean" },
            secret: { type: "boolean" },
            key: { type: "string" },
            count: { type: "integer", minimum: 1 },
            wait_type: { type: "string", enum: waitTypes },
            method: { type: "string" },
            path: { type: "string" },
            status_code: { type: "integer", minimum: 100, maximum: 599 },
            duration_ms: { type: "integer", minimum: 1 },
            name: { type: "string" },
            full_page: { type: "boolean" },
          },
          required: ["kind"],
        },
      },
    };
  }

  private expectationToolSchema(): Record<string, unknown> {
    return {
      type: "function",
      function: {
        name: "emit_expectation",
        description: "Emit exactly one canonical expectation object.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: expectationKinds },
            value: { type: "string" },
            text: { type: "string" },
            target: this.targetSchema(),
            container: this.targetSchema(),
            method: { type: "string" },
            path: { type: "string" },
            status_code: { type: "integer", minimum: 100, maximum: 599 },
            soft: { type: "boolean" },
            rule_name: { type: "string" },
            parameters: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["kind"],
        },
      },
    };
  }

  private testOutlineToolSchema(): Record<string, unknown> {
    return {
      type: "function",
      function: {
        name: "emit_test_outline",
        description: "Extract ordered step and expectation lines from free-form test text.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            steps: { type: "array", items: { type: "string" } },
            expectations: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            preconditions: { type: "array", items: { type: "string" } },
          },
          required: ["steps", "expectations"],
        },
      },
    };
  }

  private targetSchema(): Record<string, unknown> {
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        human_label: { type: "string" },
        exact_text: { type: "string" },
        role: { type: "string" },
        placeholder: { type: "string" },
        label_text: { type: "string" },
        test_id: { type: "string" },
        css: { type: "string" },
        xpath: { type: "string" },
        nth: { type: "integer", minimum: 0 },
        frame_hint: { type: "string" },
        nearby_text: { type: "string" },
        parent_hint: { type: "string" },
        require_visible: { type: "boolean" },
      },
    };
  }
}
