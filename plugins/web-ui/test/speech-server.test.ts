import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createSpeechHandler } from "../server/speech.ts";

async function fixture(configured = true, user = "alice") {
  const handler = createSpeechHandler(() => ({
    apiKey: configured ? "browser-test-key" : undefined,
    model: "assemblyai/universal-3-5-pro-realtime",
    language: "en",
  }));
  const server = createServer((_req, res) => handler(res, user));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("signed-in users receive browser streaming credentials without caching", async () => {
  const app = await fixture();
  try {
    const res = await fetch(app.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), {
      apiKey: "browser-test-key",
      model: "assemblyai/universal-3-5-pro-realtime",
      language: "en",
    });
  } finally {
    await app.close();
  }
});

test("unconfigured and anonymous users never receive credentials", async () => {
  for (const [configured, user, status] of [
    [false, "alice", 503],
    [true, "playground-0123456789", 403],
  ] as const) {
    const app = await fixture(configured, user);
    try {
      const res = await fetch(app.url);
      assert.equal(res.status, status);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.ok(!(await res.text()).includes("browser-test-key"));
    } finally {
      await app.close();
    }
  }
});
