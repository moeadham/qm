import type { ServerResponse } from "node:http";
import { json } from "../../chassis/src/http.ts";

export interface SpeechConfig {
  apiKey?: string;
  model: string;
  language?: string;
}

export function speechAllowed(user: string): boolean {
  return !user.startsWith("playground-");
}

export function speechConfig(): SpeechConfig {
  return {
    apiKey: process.env.ALLMODELS_API_KEY?.trim() || undefined,
    model: process.env.ALLMODELS_STT_MODEL?.trim() || "deepgram/nova-3",
    language: process.env.ALLMODELS_STT_LANGUAGE?.trim() || undefined,
  };
}

export function createSpeechHandler(config: () => SpeechConfig = speechConfig) {
  return (res: ServerResponse, user: string): void => {
    res.setHeader("cache-control", "no-store");
    if (!speechAllowed(user)) return json(res, 403, { message: "Sign in to use speech input." });
    const settings = config();
    if (!settings.apiKey) return json(res, 503, { message: "Speech input is not configured." });
    json(res, 200, settings);
  };
}
