export interface OpenAIFunction {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

export interface FunctionCall {
  name: string;
  arguments: string;
}
