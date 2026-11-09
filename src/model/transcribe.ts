import { httpFailure } from "../util/errors.ts";

export interface TranscriptionEndpoint {
  baseUrl: string;
  apiKey: string;
}

export type Transcribe = (audio: Uint8Array, filename: string, mimetype: string) => Promise<string>;

export function parseTranscribeModel(value: string): { providerId: string; modelId: string } {
  const split = value.indexOf(":");
  const providerId = value.slice(0, split).trim();
  const modelId = value.slice(split + 1).trim();
  if (split < 1 || !modelId) throw new Error(`TRANSCRIBE_MODEL must be "<provider id>:<model id>", got "${value}"`);
  return { providerId, modelId };
}

export function createTranscriber(
  modelId: string,
  endpoint: () => Promise<TranscriptionEndpoint | null>,
  fetchImpl: typeof fetch = fetch,
): Transcribe {
  return async (audio, filename, mimetype) => {
    const target = await endpoint();
    if (!target) throw new Error("the transcription provider is not configured or has no key");
    const form = new FormData();
    form.set("model", modelId);
    form.set("file", new Blob([audio], { type: mimetype }), filename);
    const res = await fetchImpl(`${target.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`transcription failed: ${await httpFailure(res)}`);
    const data = (await res.json()) as { text?: unknown };
    if (typeof data.text !== "string") throw new Error("transcription response had no text");
    return data.text.trim();
  };
}
