import type { CustomProviderStore } from "./custom-provider-store.ts";
import { httpFailure } from "../util/errors.ts";

export type Transcribe = (audio: Uint8Array, filename: string, mimetype: string) => Promise<string>;

export function parseTranscribeModel(value: string): { providerId: string; modelId: string } {
  const split = value.indexOf(":");
  const providerId = value.slice(0, split).trim();
  const modelId = value.slice(split + 1).trim();
  if (split < 1 || !modelId) throw new Error(`TRANSCRIBE_MODEL must be "<provider id>:<model id>", got "${value}"`);
  return { providerId, modelId };
}

export function createTranscriber(
  providers: Pick<CustomProviderStore, "enabled" | "resolveKey">,
  target: ReturnType<typeof parseTranscribeModel>,
  fetchImpl: typeof fetch = fetch,
): Transcribe {
  return async (audio, filename, mimetype) => {
    const spec = (await providers.enabled()).find((p) => p.id === target.providerId);
    const apiKey = spec && spec.protocol !== "anthropic" ? await providers.resolveKey(spec.id) : null;
    if (!spec || !apiKey)
      throw new Error(`transcription provider ${target.providerId} is not configured or has no key`);
    const form = new FormData();
    form.set("model", target.modelId);
    form.set("file", new Blob([audio], { type: mimetype }), filename);
    const res = await fetchImpl(`${spec.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`transcription failed: ${await httpFailure(res)}`);
    const data = (await res.json()) as { text?: unknown };
    if (typeof data.text !== "string") throw new Error("transcription response had no text");
    return data.text.trim();
  };
}
