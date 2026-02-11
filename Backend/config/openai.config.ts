import OpenAI from "openai";
import { config } from "./env.config";

export const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

export const OPENAI_CONFIG = {
  model: config.openai.model,
  temperature: 0.7,
  maxTokens: 500,
};
