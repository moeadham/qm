import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { baseModelProviders, configuredModelForHarness, providerKeysPresent } from "../src/config.ts";
import { defaultModelForHarness, modelProviderAvailabilityFor } from "../src/model/pi-models.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function start(overrides: Parameters<typeof testConfig>[0] = { anthropicApiKey: "deployment-anthropic-key" }) {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "base-model-svc-")), harness: "pi", ...overrides });
  const built = buildApp(config);
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    acl: built.acl,
    modelCredentials: built.modelCredentials,
    harnessId: "pi",
    baseModelDefault: defaultModelForHarness("pi", configuredModelForHarness(config, "pi"), baseModelProviders(config)),
    providerKeys: providerKeysPresent(config),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function effectiveModel(base: string): Promise<string> {
  const res = await fetch(`${base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { effective: { modelId: string } }).effective.modelId;
}

test("base-model set rejects a model whose provider key is absent (would fail provider-side)", async () => {
  const srv = start();
  try {
    const bad = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "gpt-5.6-sol" }),
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { message?: string }).message ?? "", /serviceable|provider key/i);

    const ok = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "claude-opus-4-8" }),
    });
    assert.equal(ok.status, 200, "an Anthropic model stays selectable when the Anthropic key is present");
  } finally {
    await srv.close();
  }
});

test("ChatGPT OAuth stays separate from OpenAI API-key availability on Pi", () => {
  const config = testConfig({ harness: "pi", codexAuthFile: "/tmp/chatgpt-auth.json" });
  const configured = providerKeysPresent(config);
  assert.equal(configured.openai, false);
  assert.equal(configured.codexOAuth, true);
  assert.equal(modelProviderAvailabilityFor("pi", configured).openai, false);
});

test("a deployment that declares a provider runs that provider's base model", async () => {
  for (const [modelProvider, key, expected] of [
    ["anthropic", "anthropicApiKey", "claude-opus-5"],
    ["openai", "openaiApiKey", "gpt-5.6-sol"],
    ["openrouter", "openrouterApiKey", "openrouter/auto"],
  ] as const) {
    const srv = start({ modelProvider, [key]: `deployment-${modelProvider}-key` });
    try {
      assert.equal(
        await effectiveModel(srv.base),
        expected,
        `modelProvider "${modelProvider}" must land on a model that provider can bill`,
      );
    } finally {
      await srv.close();
    }
  }
});

test("an undeclared deployment keeps the shipped default, whatever keys it holds", async () => {
  for (const overrides of [{}, { openrouterApiKey: "k" }, { openaiApiKey: "k" }] as const) {
    const srv = start(overrides);
    try {
      assert.equal(
        await effectiveModel(srv.base),
        "claude-opus-5",
        "upgrading must not move an existing deployment's model or its billing",
      );
    } finally {
      await srv.close();
    }
  }
});

test("the declaration outranks a stray key from another vendor", async () => {
  const srv = start({
    modelProvider: "openrouter",
    openrouterApiKey: "deployment-openrouter-key",
    anthropicApiKey: "stray-anthropic-key",
  });
  try {
    assert.equal(await effectiveModel(srv.base), "openrouter/auto");
  } finally {
    await srv.close();
  }
});

test("an admin-connected org ChatGPT login offers the Codex models with no API key", async () => {
  const srv = start({});
  const piModels = async () => {
    const res = await fetch(`${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { modelsByHarness: Record<string, string[]> }).modelsByHarness.pi ?? [];
  };
  try {
    assert.ok(!(await piModels()).includes("gpt-5.6-sol"));
    await srv.built.userModelCredentials.setOAuth("org:default-org", "openai", {
      accessToken: "org-codex-access",
      refreshToken: "org-codex-refresh",
      expiresAt: Date.now() + 3_600_000,
    });
    assert.ok((await piModels()).includes("gpt-5.6-sol"));
  } finally {
    await srv.close();
  }
});
