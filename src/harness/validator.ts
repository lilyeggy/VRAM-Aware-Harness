import type { Message, CompletionResult } from "../types/index.ts";
import { LLMClient } from "../client/llm-client.ts";

export type ValidatorFunction = (content: string) => ValidationResult;

export interface ValidationResult {
  valid: boolean;
  error?: string;
  details?: string;
}

export interface ValidatorConfig {
  maxRetries: number;
  retryPromptTemplate: string;
}

const DEFAULT_CONFIG: ValidatorConfig = {
  maxRetries: 2,
  retryPromptTemplate: `Your previous response had the following error:

{error}

Please fix this error and provide a corrected response. Output only the corrected content, no explanations.`,
};

export class OutputValidator {
  private config: ValidatorConfig;
  private llmClient: LLMClient;

  constructor(llmClient: LLMClient, config?: Partial<ValidatorConfig>) {
    this.llmClient = llmClient;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  validateJsonSchema(content: string, schema: Record<string, unknown>): ValidationResult {
    try {
      const parsed = JSON.parse(content);
      const errors = this.validateObject(parsed, schema, "");
      if (errors.length > 0) {
        return {
          valid: false,
          error: "JSON Schema validation failed",
          details: errors.join("; "),
        };
      }
      return { valid: true };
    } catch (e) {
      return {
        valid: false,
        error: "Invalid JSON",
        details: e instanceof Error ? e.message : "Unknown parsing error",
      };
    }
  }

  private validateObject(
    obj: unknown,
    schema: Record<string, unknown>,
    path: string
  ): string[] {
    const errors: string[] = [];

    if (schema.type === "object" && typeof obj !== "object") {
      errors.push(`${path}: expected object, got ${typeof obj}`);
      return errors;
    }

    if (schema.properties && typeof obj === "object" && obj !== null) {
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      const required = schema.required as string[] | undefined;

      for (const [key, propSchema] of Object.entries(properties)) {
        const value = (obj as Record<string, unknown>)[key];
        const propPath = path ? `${path}.${key}` : key;

        if (value === undefined) {
          if (required?.includes(key)) {
            errors.push(`${propPath}: required field missing`);
          }
          continue;
        }

        if (propSchema.type === "string" && typeof value !== "string") {
          errors.push(`${propPath}: expected string, got ${typeof value}`);
        } else if (propSchema.type === "number" && typeof value !== "number") {
          errors.push(`${propPath}: expected number, got ${typeof value}`);
        } else if (propSchema.type === "boolean" && typeof value !== "boolean") {
          errors.push(`${propPath}: expected boolean, got ${typeof value}`);
        } else if (propSchema.type === "object" && typeof value === "object") {
          errors.push(...this.validateObject(value, propSchema, propPath));
        }
      }
    }

    return errors;
  }

  validateCustom(content: string, validator: ValidatorFunction): ValidationResult {
    return validator(content);
  }

  async validateWithRetry(
    messages: Message[],
    validator: ValidatorFunction | Record<string, unknown>,
    options?: { temperature?: number; max_tokens?: number }
  ): Promise<{ result: ValidationResult; attempts: number; correctedContent?: string }> {
    let lastContent = "";
    let lastError = "";

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const response = await this.llmClient.complete(messages, options);
      lastContent = response.content;

      const result = typeof validator === "function"
        ? this.validateCustom(response.content, validator)
        : this.validateJsonSchema(response.content, validator);

      if (result.valid) {
        return { result, attempts: attempt + 1, correctedContent: response.content };
      }

      lastError = result.details ?? result.error ?? "Unknown validation error";

      if (attempt < this.config.maxRetries) {
        const retryPrompt = this.config.retryPromptTemplate.replace("{error}", lastError);
        messages.push({
          role: "assistant",
          content: response.content,
        });
        messages.push({
          role: "user",
          content: retryPrompt,
        });
      }
    }

    return {
      result: {
        valid: false,
        error: "Validation failed after retries",
        details: `Failed after ${this.config.maxRetries + 1} attempts. Last error: ${lastError}`,
      },
      attempts: this.config.maxRetries + 1,
      correctedContent: lastContent,
    };
  }

  createHelpRequest(validationError: string): Message {
    return {
      role: "user",
      content: `[SYSTEM] Previous response failed validation: ${validationError}\n\nPlease provide a response in any format that addresses the user's request.`,
    };
  }
}
