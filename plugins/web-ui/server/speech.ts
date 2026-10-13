import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "../../chassis/src/http.ts";

export const MAX_SPEECH_BYTES = 8 * 1024 * 1024;
const AUDIO_TYPES = new Map([
  ["audio/webm", "webm"],
  ["audio/mp4", "m4a"],
  ["audio/ogg", "ogg"],
  ["audio/wav", "wav"],
]);

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
    model: process.env.ALLMODELS_STT_MODEL?.trim() || "openai/whisper-1",
    language: process.env.ALLMODELS_STT_LANGUAGE?.trim() || undefined,
  };
}

export function createSpeechHandler(config: () => SpeechConfig = speechConfig, request: typeof fetch = fetch) {
  const active = new Set<string>();
  return async (req: IncomingMessage, res: ServerResponse, user: string): Promise<void> => {
    res.setHeader("cache-control", "no-store");
    if (!speechAllowed(user)) return json(res, 403, { message: "Sign in to use speech input." });
    const settings = config();
    if (!settings.apiKey) return json(res, 503, { message: "Speech input is not configured." });
    const mime = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
    const extension = AUDIO_TYPES.get(mime);
    if (!extension) return json(res, 415, { message: "Unsupported recording format." });
    if (Number(req.headers["content-length"]) > MAX_SPEECH_BYTES)
      return json(res, 413, { message: "Recording is too large. Try a shorter instruction." });
    if (active.has(user) || active.size >= 8)
      return json(res, 429, { message: "Speech input is busy. Try again shortly." });
    active.add(user);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const cancel = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.once("close", cancel);
    const abortUpload = () => req.destroy();
    controller.signal.addEventListener("abort", abortUpload, { once: true });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_SPEECH_BYTES)
          return json(res, 413, { message: "Recording is too large. Try a shorter instruction." });
        chunks.push(bytes);
      }
      controller.signal.removeEventListener("abort", abortUpload);
      if (!size) return json(res, 400, { message: "The recording was empty. Try again." });
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(Buffer.concat(chunks))], { type: mime }), `instruction.${extension}`);
      form.set("model", settings.model);
      form.set("response_format", "json");
      if (settings.language) form.set("language", settings.language);
      const upstream = await request("https://api.allmodels.io/oai/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${settings.apiKey}` },
        body: form,
        signal: controller.signal,
        redirect: "error",
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return json(res, 502, {
          message: "AllModels could not transcribe this recording. Check the API key, balance and STT model.",
        });
      }
      if (!upstream.body) throw new Error("empty_response");
      const reader = upstream.body.getReader();
      const responseChunks: Uint8Array[] = [];
      let responseSize = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        responseSize += part.value.length;
        if (responseSize > 64 * 1024) {
          await reader.cancel();
          throw new Error("response_too_large");
        }
        responseChunks.push(part.value);
      }
      const result: unknown = JSON.parse(Buffer.concat(responseChunks).toString("utf8"));
      const text = result && typeof result === "object" && "text" in result ? result.text : undefined;
      if (typeof text !== "string" || text.includes(settings.apiKey)) throw new Error("invalid_transcript");
      json(res, 200, { text: text.trim() });
    } catch {
      if (!res.destroyed)
        json(res, controller.signal.aborted ? 504 : 502, {
          message: controller.signal.aborted
            ? "Transcription timed out. Try a shorter recording."
            : "Speech transcription failed. Try again.",
        });
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", abortUpload);
      res.removeListener("close", cancel);
      active.delete(user);
    }
  };
}
