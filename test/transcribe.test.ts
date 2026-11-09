import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranscriber, parseTranscribeModel } from "../src/model/transcribe.ts";

const providers = (specs: Array<{ id: string; protocol: "openai" | "anthropic" }>, key: string | null) => ({
  enabled: async () => specs.map((s) => ({ ...s, name: s.id, baseUrl: `https://${s.id}.test/oai/`, models: [] })),
  resolveKey: async () => key,
});
const target = { providerId: "allmodels", modelId: "openai/gpt-transcribe" };

test("the transcriber posts the audio to the provider's OpenAI-style transcription endpoint", async () => {
  const seen: Array<{ url: string; auth: string | null; model: unknown; file: File }> = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const form = init!.body as FormData;
    seen.push({
      url: String(url),
      auth: new Headers(init!.headers).get("authorization"),
      model: form.get("model"),
      file: form.get("file") as File,
    });
    return Response.json({ text: "  hello there  " });
  }) as typeof fetch;
  const transcribe = createTranscriber(providers([{ id: "allmodels", protocol: "openai" }], "k-1"), target, fakeFetch);
  assert.equal(await transcribe(new TextEncoder().encode("OGG"), "voice-message.ogg", "audio/ogg"), "hello there");
  assert.equal(seen[0]!.url, "https://allmodels.test/oai/audio/transcriptions");
  assert.equal(seen[0]!.auth, "Bearer k-1");
  assert.equal(seen[0]!.model, "openai/gpt-transcribe");
  assert.equal(seen[0]!.file.name, "voice-message.ogg");
  assert.equal(await seen[0]!.file.text(), "OGG");
});

test("the transcriber fails on a provider error, or when the provider is missing, keyless or not OpenAI-style", async () => {
  const never = (async () => {
    throw new Error("should not be called");
  }) as unknown as typeof fetch;
  const audio = new Uint8Array(1);
  await assert.rejects(
    createTranscriber(
      providers([{ id: "allmodels", protocol: "openai" }], "k"),
      target,
      (async () => new Response("no credit", { status: 402 })) as unknown as typeof fetch,
    )(audio, "a.ogg", "audio/ogg"),
    /402/,
  );
  for (const setup of [
    providers([], "k"),
    providers([{ id: "allmodels", protocol: "openai" }], null),
    providers([{ id: "allmodels", protocol: "anthropic" }], "k"),
  ])
    await assert.rejects(createTranscriber(setup, target, never)(audio, "a.ogg", "audio/ogg"), /not configured/);
});

test("TRANSCRIBE_MODEL names a provider and a model", () => {
  assert.deepEqual(parseTranscribeModel("allmodels:openai/gpt-transcribe"), target);
  assert.throws(() => parseTranscribeModel("openai/gpt-transcribe"), /provider id/);
});
