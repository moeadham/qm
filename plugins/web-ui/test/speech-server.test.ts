import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createSpeechHandler, MAX_SPEECH_BYTES, speechAllowed } from "../server/speech.ts";

async function fixture(
  configured = true,
  upstream: typeof fetch = async () => Response.json({ text: "Build a speech plugin" }),
) {
  const handler = createSpeechHandler(
    () => ({ apiKey: configured ? "private-test-key" : undefined, model: "openai/whisper-1" }),
    upstream,
  );
  const server = createServer((req, res) => {
    void handler(req, res, "alice");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const recording = {
  method: "POST",
  headers: { "content-type": "audio/webm;codecs=opus" },
  body: new Uint8Array([1, 2, 3]),
};

test("forwards multipart audio with server credentials and returns only text", async () => {
  const app = await fixture(true, async (url, init) => {
    assert.equal(url, "https://api.allmodels.io/oai/audio/transcriptions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-test-key");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("model"), "openai/whisper-1");
    const file = init.body.get("file");
    assert.ok(file instanceof Blob);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([1, 2, 3]));
    return Response.json({ text: "  Build a speech plugin  ", provider: "private-metadata" });
  });
  try {
    const res = await fetch(app.url, recording);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { text: "Build a speech plugin" });
  } finally {
    await app.close();
  }
});

test("disabled input, form uploads, empty and oversized recordings never reach AllModels", async () => {
  let calls = 0;
  const upstream: typeof fetch = async () => {
    calls++;
    return Response.json({ text: "" });
  };
  const disabled = await fixture(false, upstream);
  const app = await fixture(true, upstream);
  try {
    assert.equal((await fetch(disabled.url, recording)).status, 503);
    assert.equal((await fetch(app.url, { method: "POST", body: "form" })).status, 415);
    assert.equal((await fetch(app.url, { ...recording, body: new Uint8Array() })).status, 400);
    assert.equal((await fetch(app.url, { ...recording, body: new Uint8Array(MAX_SPEECH_BYTES + 1) })).status, 413);
    assert.equal(calls, 0);
  } finally {
    await disabled.close();
    await app.close();
  }
});

test("provider errors and reflected credentials are never returned", async () => {
  for (const response of [
    new Response("private-test-key", { status: 401 }),
    Response.json({ text: "private-test-key" }),
    Response.json({ invalid: true }),
    new Response("invalid json"),
  ]) {
    const app = await fixture(true, async () => response);
    try {
      const res = await fetch(app.url, recording);
      assert.equal(res.status, 502);
      assert.ok(!(await res.text()).includes("private-test-key"));
    } finally {
      await app.close();
    }
  }
});

test("overlapping requests from one user are rejected and cancellation releases the slot", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const app = await fixture(true, async (_url, init) => {
    started();
    await new Promise<void>((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
    return Response.json({ text: "" });
  });
  const controller = new AbortController();
  try {
    const first = fetch(app.url, { ...recording, signal: controller.signal }).catch(() => undefined);
    await ready;
    assert.equal((await fetch(app.url, recording)).status, 429);
    controller.abort();
    await first;
  } finally {
    await app.close();
  }
});

test("anonymous playground principals cannot use the shared speech key", () => {
  assert.equal(speechAllowed("playground-0123456789"), false);
  assert.equal(speechAllowed("alice@example.com"), true);
});
