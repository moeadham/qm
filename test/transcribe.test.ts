import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranscriber, parseTranscribeModel } from "../src/model/transcribe.ts";

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
  const transcribe = createTranscriber(
    "openai/gpt-transcribe",
    async () => ({ baseUrl: "https://api.allmodels.io/oai/", apiKey: "k-1" }),
    fakeFetch,
  );
  assert.equal(await transcribe(new TextEncoder().encode("OGG"), "voice-message.ogg", "audio/ogg"), "hello there");
  assert.equal(seen[0]!.url, "https://api.allmodels.io/oai/audio/transcriptions");
  assert.equal(seen[0]!.auth, "Bearer k-1");
  assert.equal(seen[0]!.model, "openai/gpt-transcribe");
  assert.equal(seen[0]!.file.name, "voice-message.ogg");
  assert.equal(await seen[0]!.file.text(), "OGG");
});

test("the transcriber reports a provider failure and a missing provider", async () => {
  const failing = createTranscriber(
    "m",
    async () => ({ baseUrl: "https://x.test", apiKey: "k" }),
    (async () => new Response("no credit", { status: 402 })) as unknown as typeof fetch,
  );
  await assert.rejects(failing(new Uint8Array(1), "a.ogg", "audio/ogg"), /402/);
  await assert.rejects(
    createTranscriber("m", async () => null)(new Uint8Array(1), "a.ogg", "audio/ogg"),
    /not configured/,
  );
});

test("TRANSCRIBE_MODEL names a provider and a model", () => {
  assert.deepEqual(parseTranscribeModel("allmodels:openai/gpt-transcribe"), {
    providerId: "allmodels",
    modelId: "openai/gpt-transcribe",
  });
  assert.throws(() => parseTranscribeModel("openai/gpt-transcribe"), /provider id/);
});
