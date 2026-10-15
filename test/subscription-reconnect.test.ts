import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createUserModelCredentialStore } from "../src/model/user-model-credential-store.ts";

function fixture(refreshConnector?: Parameters<typeof createKeychain>[0]["refreshConnector"]) {
  const creds = createMemoryMap<import("../src/credentials/keychain.ts").KeychainCredential>();
  const lock = createMemoryAdvisoryLock();
  const make = () =>
    createKeychain({
      creds,
      grants: createMemoryMap(),
      asks: createMemoryMap(),
      key: deriveConnectorKey("subscription-reconnect-test-key-material"),
      lock,
      refreshConnector,
    });
  return { make, creds };
}

for (const first of ["anthropic", "openai"] as const) {
  test(`reconnecting ${first} preserves the other subscription and user`, async () => {
    const { make } = fixture();
    const store = createUserModelCredentialStore({ keychain: make() });
    for (const user of ["alice", "bob"])
      for (const provider of ["anthropic", "openai"] as const)
        await store.setOAuth(user, provider, {
          accessToken: user + provider,
          refreshToken: "refresh",
          expiresAt: Date.now() + 3600000,
        });
    const other = first === "anthropic" ? "openai" : "anthropic";
    await store.setOAuth("alice", first, {
      accessToken: "replacement",
      refreshToken: "new-refresh",
      expiresAt: Date.now() + 3600000,
    });
    assert.equal((await store.derivedOAuth("alice", other))?.accessToken, "alice" + other);
    assert.equal((await store.derivedOAuth("bob", first))?.accessToken, "bob" + first);
    assert.equal((await store.derivedOAuth("alice", first))?.accessToken, "replacement");
    assert.equal((await store.connections("alice")).length, 2);
    await store.delete("alice", first);
    assert.equal((await store.derivedOAuth("alice", other))?.accessToken, "alice" + other);
  });
}

test("two server instances refresh a rotating subscription only once", async () => {
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0;
  const { make } = fixture(async (_host, token) => {
    calls++;
    assert.equal(token.refreshToken, "original-refresh");
    started.resolve();
    await release.promise;
    return { accessToken: "fresh", refreshToken: "rotated-refresh", expiresAt: Date.now() + 3600000 };
  });
  const a = make(),
    b = make();
  await a.setConnectorToken(
    "claude.ai",
    "alice",
    { accessToken: "expired", refreshToken: "original-refresh", expiresAt: 1 },
    "individual-model",
  );
  const first = a.connectorDerivedAuth("claude.ai", "alice", "individual-model");
  await started.promise;
  const second = b.connectorDerivedAuth("claude.ai", "alice", "individual-model");
  await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(
    results.map((x) => x?.accessToken),
    ["fresh", "fresh"],
  );
});

test("reconnection survives an in-flight refresh and never blocks the other provider", async () => {
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const { make } = fixture(async () => {
    started.resolve();
    await release.promise;
    return { accessToken: "refresh-result", refreshToken: "rotated", expiresAt: Date.now() + 3600000 };
  });
  const a = createUserModelCredentialStore({ keychain: make() }),
    b = createUserModelCredentialStore({ keychain: make() });
  await a.setOAuth("alice", "anthropic", { accessToken: "old", refreshToken: "old-refresh", expiresAt: 1 });
  const refresh = a.derivedOAuth("alice", "anthropic");
  await started.promise;
  await b.setOAuth("alice", "openai", { accessToken: "codex", expiresAt: Date.now() + 3600000 });
  const reconnect = b.setOAuth("alice", "anthropic", {
    accessToken: "reconnected",
    refreshToken: "new-refresh",
    expiresAt: Date.now() + 3600000,
  });
  release.resolve();
  await Promise.all([refresh, reconnect]);
  assert.equal((await a.derivedOAuth("alice", "anthropic"))?.accessToken, "reconnected");
  assert.equal((await a.derivedOAuth("alice", "openai"))?.accessToken, "codex");
});

test("legacy Codex logins without expiry refresh from their access-token JWT deadline", async () => {
  let calls = 0;
  const { make } = fixture(async () => {
    calls++;
    return { accessToken: "fresh", refreshToken: "rotated", expiresAt: Date.now() + 3600000 };
  });
  const k = make();
  const accessToken = "e30." + Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url") + ".sig";
  await k.setConnectorToken("auth.openai.com", "alice", { accessToken, refreshToken: "refresh" }, "individual-model");
  assert.equal((await k.connectorTokenStatus("auth.openai.com", "alice", "individual-model")).expiresAt, 1000);
  assert.equal((await k.connectorDerivedAuth("auth.openai.com", "alice", "individual-model"))?.accessToken, "fresh");
  assert.equal(calls, 1);
});

test("failed Claude refresh is visible as reconnect-required without disabling Codex", async () => {
  const { make } = fixture(async () => {
    throw new Error("claude refresh failed (400)");
  });
  const store = createUserModelCredentialStore({ keychain: make() });
  await store.setOAuth("alice", "anthropic", { accessToken: "expired", refreshToken: "invalid", expiresAt: 1 });
  await store.setOAuth("alice", "openai", { accessToken: "codex", expiresAt: Date.now() + 3600000 });
  assert.equal(await store.derivedOAuth("alice", "anthropic"), null);
  assert.deepEqual(await store.connections("alice"), [
    { provider: "anthropic", kind: "oauth", needsReconnect: true },
    { provider: "openai", kind: "oauth" },
  ]);
  assert.equal((await store.derivedOAuth("alice", "openai"))?.accessToken, "codex");
});
