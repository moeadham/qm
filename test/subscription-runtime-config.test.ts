import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeConfigBody } from "../src/api/runtime-config.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createUserModelCredentialStore } from "../src/model/user-model-credential-store.ts";

async function setup() {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["claude", "codex"]);
  config.setIndividualModelAuth(true);
  await config.flushScope("org:default-org");
  const userModelCredentials = createUserModelCredentialStore({
    keychain: createKeychain({
      creds: createMemoryMap(),
      grants: createMemoryMap(),
      asks: createMemoryMap(),
      key: deriveConnectorKey("subscription-runtime-config-test-key"),
    }),
  });
  await userModelCredentials.setOAuth("alice", "openai", { accessToken: "test-access", idToken: "test-id" });
  const ctx = {
    deps: {
      config,
      userModelCredentials,
      harnessId: "claude",
      providerKeys: { anthropic: false, openai: false, openrouter: false },
    },
  };
  return { config, userModelCredentials, ctx };
}

test("Codex subscription advertises Astra without deployment API keys and preserves a saved selection", async () => {
  const { config, ctx } = await setup();
  const initial = await runtimeConfigBody(ctx, "personal:alice", "alice");
  assert.deepEqual(initial.approvedHarnesses, ["codex"]);
  assert.ok(initial.modelsByHarness.codex?.includes("gpt-6-astra"));
  assert.ok(initial.modelsByHarness.codex?.includes("gpt-5.6-sol"));
  assert.deepEqual(initial.effective, { harnessId: "codex", modelId: "gpt-5.6-sol" });
  await config.setRuntimeSelectionLatest("personal:alice", { harnessId: "codex", modelId: "gpt-6-astra" });
  assert.equal((await runtimeConfigBody(ctx, "personal:alice", "alice")).effective.modelId, "gpt-6-astra");
  const other = await runtimeConfigBody(ctx, "personal:bob", "bob");
  assert.deepEqual(other.approvedHarnesses, []);
  assert.deepEqual(other.modelsByHarness.codex, []);
});

test("subscription models obey the current org allowlist even when a disallowed model was saved", async () => {
  const { config, ctx } = await setup();
  await config.setRuntimeSelectionLatest("personal:alice", { harnessId: "codex", modelId: "gpt-6-astra" });
  config.setWebuiModels("org:default-org", ["gpt-5.6-sol"]);
  await config.flushScope("org:default-org");
  const result = await runtimeConfigBody(ctx, "personal:alice", "alice");
  assert.deepEqual(result.modelsByHarness.codex, ["gpt-5.6-sol"]);
  assert.ok(result.unavailableReason);
  config.setApprovedHarnesses(["claude"]);
  await config.flushScope("org:default-org");
  assert.deepEqual((await runtimeConfigBody(ctx, "personal:alice", "alice")).approvedHarnesses, []);
});

test("disconnecting ChatGPT removes its models even when deployment keys are available", async () => {
  const { ctx, userModelCredentials } = await setup();
  await userModelCredentials.delete("alice", "openai");
  ctx.deps.providerKeys = { anthropic: true, openai: true, openrouter: true };
  assert.deepEqual((await runtimeConfigBody(ctx, "personal:alice", "alice")).approvedHarnesses, []);
});

test("provider-specific personal access filters the picker even with company access as the default", async () => {
  const { config, ctx, userModelCredentials } = await setup();
  config.setIndividualModelAuth(false);
  await config.flushScope("org:default-org");
  await config.setPersonalModelAuth("alice", true, "openai");
  await userModelCredentials.setOAuth("alice", "anthropic", { accessToken: "test-claude" });
  const result = await runtimeConfigBody(ctx, "personal:alice", "alice");
  assert.deepEqual(result.approvedHarnesses, ["codex"]);
  assert.ok(result.modelsByHarness.codex?.includes("gpt-6-astra"));
  assert.deepEqual(result.modelsByHarness.claude, []);
});

test("current Claude and Codex models remain selectable through subscription credentials", async () => {
  const { config, ctx, userModelCredentials } = await setup();
  await userModelCredentials.setOAuth("alice", "anthropic", { accessToken: "test-claude" });
  for (const [harnessId, modelId] of [
    ["claude", "claude-opus-5-5"],
    ["codex", "gpt-6-sol"],
    ["codex", "gpt-6-luna"],
  ] as const) {
    await config.setRuntimeSelectionLatest("personal:alice", { harnessId, modelId });
    const result = await runtimeConfigBody(ctx, "personal:alice", "alice");
    assert.ok(result.modelsByHarness[harnessId]?.includes(modelId));
    assert.equal(result.effective.harnessId, harnessId);
    assert.equal(result.effective.modelId, modelId);
    assert.ok(result.modelCatalog[modelId]);
  }
});
