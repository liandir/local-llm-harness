export interface JsonSchema {
  type: "object" | "array" | "string" | "integer" | "number" | "boolean";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
}

export interface ToolSpec {
  availability?: { modes: ("plan" | "review" | "act")[]; transport?: "native" | "legacy"; setting?: string };
  name: string;
  description: string;
  parameters: JsonSchema & { type: "object"; properties: Record<string, JsonSchema> };
}

export interface OpenAiTool {
  type: "function";
  function: ToolSpec;
}

export function asOpenAiTools(tools: ToolSpec[]): OpenAiTool[] {
  return tools.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } }));
}

export const objectParameters = (
  properties: Record<string, JsonSchema>,
  required: string[]
): ToolSpec["parameters"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});

