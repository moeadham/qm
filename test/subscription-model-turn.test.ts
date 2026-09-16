import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { testConfig } from "./support/test-config.ts";

const codex = await import("../src/harness/codex-harness.ts");
const seen: HarnessTurnInput[] = [];
mock.module("../src/harness/codex-harness.ts", {
  namedExports: {
    ...codex,
    createCodexHarness: () => {
      const harness = createMockHarness();
      return {
        ...harness,
        id: "codex",
        turns: {
          ...harness.turns,
          runTurn: async (turn: HarnessTurnInput) => {
            seen.push(turn);
            return { reply: "subscription model selected", modelCalls: 1 };
          },
        },
      };
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

test("web Astra selection reaches Codex with personal OAuth through app and orchestrator", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
  try {
    built.config.setIndividualModelAuth(true);
    built.config.setApprovedHarnesses(["mock", "codex", "claude"]);
    await built.config.flushScope("org:default-org");
    await built.config.setRuntimeSelectionLatest("org:default-org", {
      harnessId: "claude",
      modelId: "claude-sonnet-5",
    });
    await built.userModelCredentials.setOAuth("internal:alice", "openai", {
      accessToken: "test-access",
      idToken: "test-id",
      accountId: "test-account",
      expiresAt: Date.now() + 3600000,
    });
    const request = {
      surface: "web",
      liveActor: true,
      actor: { externalId: "internal:alice" },
      conversation: { kind: "dm" as const, threadRef: "subscription-astra-test" },
      text: "Test the selected model",
      harness: "codex",
      model: "gpt-6-astra",
      skipMemory: true,
    };
    const result = await built.app.turn(request);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.runtime?.modelId, "gpt-6-astra");
    assert.equal(seen[0]?.codexAuth?.accountId, "test-account");
    await built.userModelCredentials.delete("internal:alice", "openai");
    assert.equal(
      (await built.app.turn({ ...request, conversation: { ...request.conversation, threadRef: "disconnected-test" } }))
        .status,
      "refused",
    );
    assert.equal(seen.length, 1);
  } finally {
    await built.runtime.stop();
  }
});

for (const connected of [true, false]) {
  test(`owner-authenticated automation ${connected ? "uses the scoped Codex subscription" : "fails closed without the owner's connection"}`, async () => {
    const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
    const start = seen.length;
    try {
      built.config.setIndividualModelAuth(true);
      built.config.setApprovedHarnesses(["mock", "codex", "claude"]);
      await built.config.flushScope("org:default-org");
      await built.config.setRuntimeSelectionLatest("org:default-org", {
        harnessId: "claude",
        modelId: "claude-sonnet-5",
      });
      await built.config.setRuntimeSelectionLatest("personal:internal:alice", {
        harnessId: "codex",
        modelId: "gpt-5.6-sol",
      });
      await built.userModelCredentials.setOAuth(connected ? "internal:alice" : "internal:bob", "openai", {
        accessToken: "test-access",
        idToken: "test-id",
        accountId: "owner-account",
        expiresAt: Date.now() + 3600000,
      });
      const pending = built.app.turn({
        surface: "cron",
        triggered: true,
        origin: { kind: "automation", useOwnerModelAuth: true },
        actor: { externalId: "internal:alice" },
        conversation: { kind: "dm", threadRef: `cron-subscription-${connected}` },
        text: "Return a diagnostic reply",
        skipMemory: true,
      });
      if (connected) {
        const result = await pending;
        assert.equal(result.status, "ok", JSON.stringify(result));
        assert.equal(seen.length, start + 1);
        assert.equal(seen[start]?.runtime?.modelId, "gpt-5.6-sol");
        assert.equal(seen[start]?.codexAuth?.accountId, "owner-account");
        assert.equal(seen[start]?.runtimeActorId, "internal:alice");
      } else {
        await assert.rejects(pending, /owner to connect/);
        assert.equal(seen.length, start);
      }
    } finally {
      await built.runtime.stop();
    }
  });
}
