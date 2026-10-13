import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { runTrigger } from "../src/triggers/run-trigger.ts";
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
      await built.config.setPersonalModelAuth("internal:alice", true, "openai");
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

for (const connected of [true, false]) {
  test(`delegated Codex override ${connected ? "uses owner OAuth over the Claude scope default" : "fails closed after disconnect"}`, async () => {
    const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
    const start = seen.length;
    try {
      await built.config.setPersonalModelAuth("internal:alice", true);
      built.config.setApprovedHarnesses(["mock", "codex", "claude"]);
      await built.config.flushScope("org:default-org");
      await built.config.setRuntimeSelectionLatest("personal:internal:alice", {
        harnessId: "claude",
        modelId: "claude-opus-5-5",
      });
      await built.userModelCredentials.setOAuth("internal:alice", "openai", {
        accessToken: "test-access",
        idToken: "test-id",
        accountId: "owner-account",
        expiresAt: Date.now() + 3600000,
      });
      if (!connected) await built.userModelCredentials.delete("internal:alice", "openai");
      const pending = built.app.turn({
        surface: "web",
        triggered: true,
        origin: { kind: "automation", useOwnerModelAuth: true },
        actor: { externalId: "internal:alice" },
        conversation: { kind: "dm", threadRef: `delegated-override-${connected}` },
        text: "Review this change",
        skipMemory: true,
        harness: "codex",
        model: "gpt-6-astra",
      });
      if (connected) {
        const result = await pending;
        assert.equal(result.status, "ok", JSON.stringify(result));
        assert.equal(seen.length, start + 1);
        assert.equal(seen[start]?.runtime?.modelId, "gpt-6-astra");
        assert.equal(seen[start]?.codexAuth?.accountId, "owner-account");
      } else {
        assert.equal((await pending).status, "refused");
        assert.equal(seen.length, start);
      }
    } finally {
      await built.runtime.stop();
    }
  });
}

for (const account of ["personal", "company", "disconnected"] as const) {
  test(`queued subagent preserves ${account} credential selection`, async () => {
    const built = buildApp(testConfig({ harness: "mock", seedSkills: false, openaiApiKey: "company-test-key" }));
    const start = seen.length;
    try {
      await built.config.setPersonalModelAuth("internal:alice", account !== "company");
      built.config.setApprovedHarnesses(["mock", "codex", "claude"]);
      await built.config.flushScope("org:default-org");
      await built.config.setRuntimeSelectionLatest("personal:internal:alice", {
        harnessId: "claude",
        modelId: "claude-opus-5-5",
      });
      await built.userModelCredentials.setOAuth("internal:alice", "openai", {
        accessToken: "test-access",
        idToken: "test-id",
        accountId: "owner-account",
        expiresAt: Date.now() + 3600000,
      });
      const actor = { id: "internal:alice", type: "internal" as const };
      const threadRef = `agent:main:subagent:account-${account}`;
      const session = await built.sessions.getOrCreateByThread(threadRef, "dm", "personal:internal:alice");
      await built.sessions.addParticipant(session.id, actor.id);
      await built.sessions.setSpawnMeta(session.id, {
        surface: "web",
        actor,
        conversation: { kind: "dm", threadRef, audience: [actor] },
      });

      const { run } = await built.runs.enqueue({
        sessionId: threadRef,
        request: {
          surface: "web",
          actor,
          conversation: { kind: "dm", threadRef, audience: [actor] },
          origin: { kind: "automation", useOwnerModelAuth: true },
          text: "Review",
          skipMemory: true,
          harness: "codex",
          model: "gpt-6-astra",
        },
      });
      if (account === "disconnected") await built.userModelCredentials.delete(actor.id, "openai");
      built.runtime.startBackground();
      let latest = await built.runs.get(run.id);
      for (let i = 0; i < 100 && (latest?.status === "pending" || latest?.status === "running"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        latest = await built.runs.get(run.id);
      }
      if (account === "disconnected") {
        assert.equal(latest?.status, "failed");
        assert.equal(seen.length, start);
        return;
      }
      assert.equal(latest?.status, "done", JSON.stringify(latest?.result));
      assert.equal(latest?.result?.status, "ok", JSON.stringify(latest?.result));
      assert.equal(seen.length, start + 1);
      assert.equal(seen[start]?.runtime?.modelId, "gpt-6-astra");
      assert.equal(seen[start]?.codexAuth?.accountId, account === "personal" ? "owner-account" : undefined);
    } finally {
      await built.runtime.stop();
    }
  });
}

for (const connected of [true, false]) {
  test(`background-command watch ${connected ? "uses the owner's Codex subscription" : "fails closed without borrowing another account"}`, async () => {
    const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
    const start = seen.length;
    try {
      await built.config.setPersonalModelAuth("internal:alice", true);
      built.config.setApprovedHarnesses(["mock", "codex", "claude"]);
      await built.config.flushScope("org:default-org");
      await built.config.setRuntimeSelectionLatest("personal:internal:alice", {
        harnessId: "codex",
        modelId: "gpt-5.6-sol",
      });
      await built.userModelCredentials.setOAuth(connected ? "internal:alice" : "internal:bob", "openai", {
        accessToken: "test-access",
        idToken: "test-id",
        accountId: "watch-owner-account",
        expiresAt: Date.now() + 3600000,
      });
      const pending = runTrigger(
        {
          deliveries: built.deliveries,
          idempotency: createIdempotencyStore(createMemoryMap()),
          identity: built.identity,
          run: (request) => built.app.turn({ ...request, skipMemory: true }),
        },
        {
          owner: "internal:alice",
          ownerScopeId: "personal:internal:alice",
          input: "Report the command result",
          securityScreenData: "REPORT_SAVED",
          fireKey: `monitor:subscription:${connected}`,
          surface: "monitor",
          threadRef: `watch-subscription-${connected}`,
        },
      );
      if (connected) {
        const outcome = await pending;
        assert.equal(outcome.status, "ok", JSON.stringify(outcome));
        assert.equal(seen.length, start + 1);
        assert.equal(seen[start]?.codexAuth?.accountId, "watch-owner-account");
      } else {
        await assert.rejects(pending, /owner to connect an AI account/);
        assert.equal(seen.length, start);
      }
    } finally {
      await built.runtime.stop();
    }
  });
}

test("cron model defaults resolve with the owner's subscription before credential routing", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
  const start = seen.length;
  try {
    await built.config.setPersonalModelAuth("internal:alice", true);
    built.config.setApprovedHarnesses(["mock", "codex", "claude"]);
    await built.config.flushScope("org:default-org");
    await built.config.setRuntimeSelectionLatest("personal:internal:alice", {
      harnessId: "claude",
      modelId: "claude-opus-5-5",
    });
    await built.config.setPurposeRuntime("cron", { harnessId: "codex", modelId: "gpt-6-sol", effortLevel: "auto" });
    await built.userModelCredentials.setOAuth("internal:alice", "openai", {
      accessToken: "test-access",
      idToken: "test-id",
      accountId: "cron-owner",
      expiresAt: Date.now() + 3600000,
    });
    const result = await built.app.turn({
      surface: "cron",
      triggered: true,
      origin: { kind: "automation", useOwnerModelAuth: true },
      actor: { externalId: "internal:alice" },
      conversation: { kind: "dm", threadRef: "owner-cron-purpose" },
      text: "Return a diagnostic reply",
      skipMemory: true,
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(seen.length, start + 1);
    assert.equal(seen[start]?.runtime?.modelId, "gpt-6-sol");
    assert.equal(seen[start]?.codexAuth?.accountId, "cron-owner");
  } finally {
    await built.runtime.stop();
  }
});

test("creating and editing an explicit Codex cron validates the owner's subscription", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
  try {
    built.config.setApprovedHarnesses(["mock", "codex", "claude"]);
    await built.config.flushScope("org:default-org");
    await built.config.setPersonalModelAuth("internal:alice", true);
    await built.userModelCredentials.setOAuth("internal:alice", "openai", {
      accessToken: "test-access",
      idToken: "test-id",
      accountId: "test-account",
      expiresAt: Date.now() + 3600000,
    });
    const input = {
      owner: "internal:alice",
      createdBy: "internal:alice",
      ownerScopeId: "personal:internal:alice" as const,
      schedule: { everyMs: 3600000 },
      action: "Inspect the fixture",
      runtime: { harnessId: "codex" as const, modelId: "gpt-6-sol" },
    };
    const cron = await built.app.createCron(input);
    assert.equal(cron.runtime?.modelId, "gpt-6-sol");
    await built.app.updateCron(cron.id, { runtime: { harnessId: "codex", modelId: "gpt-6-astra" } });
    await built.userModelCredentials.delete("internal:alice", "openai");
    await assert.rejects(
      built.app.createCron({ ...input, action: "Disconnected check" }),
      /runtime is no longer available/,
    );
  } finally {
    await built.runtime.stop();
  }
});
