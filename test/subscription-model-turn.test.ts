import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { runTrigger } from "../src/triggers/run-trigger.ts";
import { testConfig } from "./support/test-config.ts";
import { ProviderTurnError } from "../src/core/turn-error.ts";

const pi = await import("../src/harness/pi-harness.ts");
const seen: HarnessTurnInput[] = [];
mock.module("../src/harness/pi-harness.ts", {
  namedExports: {
    ...pi,
    createPiHarness: () => {
      const harness = createMockHarness();
      return {
        ...harness,
        id: "pi",
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
const claude = await import("../src/harness/claude-harness.ts");
const claudeSeen: HarnessTurnInput[] = [];
mock.module("../src/harness/claude-harness.ts", {
  namedExports: {
    ...claude,
    createClaudeHarness: () => {
      const harness = createMockHarness();
      return {
        ...harness,
        id: "claude",
        turns: {
          ...harness.turns,
          runTurn: async (turn: HarnessTurnInput) => {
            claudeSeen.push(turn);
            return { reply: "Claude subscription selected", modelCalls: 1 };
          },
        },
      };
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

test("web Astra selection reaches Pi with personal OAuth through app and orchestrator", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
  try {
    built.config.setIndividualModelAuth(true);
    built.config.setApprovedHarnesses(["mock", "pi", "claude"]);
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
      harness: "pi",
      model: "codex/gpt-6-astra",
      skipMemory: true,
    };
    const result = await built.app.turn(request);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.runtime?.modelId, "codex/gpt-6-astra");
    assert.deepEqual(seen[0]?.providerKeys, { "openai-codex": "test-access" });
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
  test(`owner-authenticated automation ${connected ? "uses the scoped ChatGPT subscription" : "fails closed without the owner's connection"}`, async () => {
    const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
    const start = seen.length;
    try {
      await built.config.setPersonalModelAuth("internal:alice", true, "openai");
      built.config.setApprovedHarnesses(["mock", "pi", "claude"]);
      await built.config.flushScope("org:default-org");
      await built.config.setRuntimeSelectionLatest("org:default-org", {
        harnessId: "claude",
        modelId: "claude-sonnet-5",
      });
      await built.config.setRuntimeSelectionLatest("personal:internal:alice", {
        harnessId: "pi",
        modelId: "codex/gpt-5.6-sol",
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
        assert.equal(seen[start]?.runtime?.modelId, "codex/gpt-5.6-sol");
        assert.deepEqual(seen[start]?.providerKeys, { "openai-codex": "test-access" });
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
  test(`delegated ChatGPT override ${connected ? "uses owner OAuth over the Claude scope default" : "fails closed after disconnect"}`, async () => {
    const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
    const start = seen.length;
    try {
      await built.config.setPersonalModelAuth("internal:alice", true);
      built.config.setApprovedHarnesses(["mock", "pi", "claude"]);
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
        harness: "pi",
        model: "codex/gpt-6-astra",
      });
      if (connected) {
        const result = await pending;
        assert.equal(result.status, "ok", JSON.stringify(result));
        assert.equal(seen.length, start + 1);
        assert.equal(seen[start]?.runtime?.modelId, "codex/gpt-6-astra");
        assert.deepEqual(seen[start]?.providerKeys, { "openai-codex": "test-access" });
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
      built.config.setApprovedHarnesses(["mock", "pi", "claude"]);
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
          harness: "pi",
          model: account === "company" ? "gpt-6-astra" : "codex/gpt-6-astra",
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
      assert.equal(seen[start]?.runtime?.modelId, account === "company" ? "gpt-6-astra" : "codex/gpt-6-astra");
      assert.deepEqual(
        seen[start]?.providerKeys,
        account === "personal" ? { "openai-codex": "test-access" } : undefined,
      );
    } finally {
      await built.runtime.stop();
    }
  });
}

test("a read-only human-delegated persistent subagent inherits only the owner's ChatGPT model auth", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
  const start = seen.length;
  try {
    await built.config.setPersonalModelAuth("internal:alice", true, "openai");
    built.config.setApprovedHarnesses(["mock", "pi", "claude"]);
    await built.config.flushScope("org:default-org");
    await built.config.setPurposeRuntime("subagent", {
      harnessId: "pi",
      modelId: "codex/gpt-5.6-sol",
      effortLevel: "auto",
    });
    await built.userModelCredentials.setOAuth("internal:alice", "openai", {
      accessToken: "test-access",
      idToken: "test-id",
      accountId: "owner-account",
      expiresAt: Date.now() + 3600000,
    });
    const actor = { id: "internal:alice", type: "internal" as const };
    const parentThread = "web:internal:alice:delegation-parent";
    const parent = await built.sessions.getOrCreateByThread(parentThread, "dm", "personal:internal:alice");
    await built.sessions.addParticipant(parent.id, actor.id);
    const parentConversation = { kind: "dm" as const, threadRef: parentThread, audience: [actor] };
    const parentRun = (
      await built.runs.enqueue({
        sessionId: parentThread,
        request: {
          surface: "web",
          actor,
          conversation: parentConversation,
          origin: { kind: "human" },
          text: "Delegate this review",
          readOnly: true,
          skipMemory: true,
        },
      })
    ).run;
    const claimed = await built.runs.claimById(parentRun.id, "test-parent", 60_000);
    assert.ok(claimed?.leaseToken);
    await built.runs.complete(parentRun.id, claimed.leaseToken, { status: "ok", reply: "delegated" });

    const childThread = "agent:main:subagent:subscription-delegation";
    const child = await built.sessions.getOrCreateByThread(childThread, "dm", "personal:internal:alice");
    await built.sessions.setParentSession(child.id, parent.id);
    await built.sessions.addParticipant(child.id, actor.id);
    await built.sessions.setSpawnMeta(child.id, {
      surface: "web",
      actor,
      conversation: parentConversation,
      origin: { kind: "human" },
    });
    const childRun = (
      await built.runs.enqueue({
        sessionId: childThread,
        request: {
          surface: "web",
          actor,
          conversation: { ...parentConversation, threadRef: childThread },
          origin: { kind: "human" },
          sessionSenderId: parent.id,
          delegatingRunId: parentRun.id,
          text: "Review the delegated change",
          readOnly: true,
          skipMemory: true,
        },
      })
    ).run;
    built.runtime.startBackground();
    const completed = await built.runs.waitFor(childRun.id, 5_000);
    assert.equal(completed.status, "done", JSON.stringify(completed.result));
    assert.equal(completed.result?.status, "ok", JSON.stringify(completed.result));
    assert.equal(seen.length, start + 1);
    assert.equal(seen[start]?.runtime?.modelId, "codex/gpt-5.6-sol");
    assert.deepEqual(seen[start]?.providerKeys, { "openai-codex": "test-access" });
  } finally {
    await built.runtime.stop();
  }
});

test("a temporary subscription refresh failure remains retryable", async () => {
  const built = buildApp(testConfig({ harness: "mock", maxAttempts: 1, seedSkills: false }));
  try {
    await built.config.setPersonalModelAuth("internal:alice", true, "anthropic");
    built.config.setApprovedHarnesses(["mock", "pi", "claude"]);
    await built.config.flushScope("org:default-org");
    await built.userModelCredentials.setOAuth("internal:alice", "anthropic", {
      accessToken: "stale-claude",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3600000,
    });
    mock.method(built.userModelCredentials, "derivedOAuth", async () => null);
    await assert.rejects(
      built.app.turn({
        surface: "cron",
        triggered: true,
        origin: { kind: "automation", useOwnerModelAuth: true },
        actor: { externalId: "internal:alice" },
        conversation: { kind: "dm", threadRef: "temporary-claude-refresh" },
        text: "Retry after the provider recovers",
        harness: "claude",
        model: "claude-opus-5-5",
        skipMemory: true,
      }),
      (error: unknown) => error instanceof ProviderTurnError && error.code === "auth" && error.retryable === true,
    );
  } finally {
    await built.runtime.stop();
  }
});

for (const connected of [true, false]) {
  test(`background-command watch ${connected ? "uses the owner's ChatGPT subscription" : "fails closed without borrowing another account"}`, async () => {
    const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
    const start = seen.length;
    try {
      await built.config.setPersonalModelAuth("internal:alice", true);
      built.config.setApprovedHarnesses(["mock", "pi", "claude"]);
      await built.config.flushScope("org:default-org");
      await built.config.setRuntimeSelectionLatest("personal:internal:alice", {
        harnessId: "pi",
        modelId: "codex/gpt-5.6-sol",
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
        assert.deepEqual(seen[start]?.providerKeys, { "openai-codex": "test-access" });
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
    built.config.setApprovedHarnesses(["mock", "pi", "claude"]);
    await built.config.flushScope("org:default-org");
    await built.config.setRuntimeSelectionLatest("personal:internal:alice", {
      harnessId: "claude",
      modelId: "claude-opus-5-5",
    });
    await built.config.setPurposeRuntime("cron", { harnessId: "pi", modelId: "codex/gpt-6-sol", effortLevel: "auto" });
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
    assert.equal(seen[start]?.runtime?.modelId, "codex/gpt-6-sol");
    assert.deepEqual(seen[start]?.providerKeys, { "openai-codex": "test-access" });
  } finally {
    await built.runtime.stop();
  }
});

test("creating and editing an explicit ChatGPT cron validates the owner's subscription", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
  try {
    built.config.setApprovedHarnesses(["mock", "pi", "claude"]);
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
      runtime: { harnessId: "pi" as const, modelId: "codex/gpt-6-sol" },
    };
    const cron = await built.app.createCron(input);
    assert.equal(cron.runtime?.modelId, "codex/gpt-6-sol");
    await built.app.updateCron(cron.id, { runtime: { harnessId: "pi", modelId: "codex/gpt-6-astra" } });
    await built.userModelCredentials.delete("internal:alice", "openai");
    await assert.rejects(
      built.app.createCron({ ...input, action: "Disconnected check" }),
      /runtime is no longer available/,
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a Claude cron in a Codex project never refreshes the unrelated OpenAI login", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
  try {
    built.config.setApprovedHarnesses(["mock", "claude", "pi"]);
    await built.config.flushScope("org:default-org");
    await built.config.setPersonalModelAuth("internal:alice", true);
    await built.config.setRuntimeSelectionLatest("personal:internal:alice", {
      harnessId: "pi",
      modelId: "codex/gpt-5.6-sol",
    });
    await built.userModelCredentials.setOAuth("internal:alice", "openai", {
      accessToken: "expired-openai",
      refreshToken: "invalid",
      expiresAt: 1,
    });
    await built.userModelCredentials.setOAuth("internal:alice", "anthropic", {
      accessToken: "valid-claude",
      expiresAt: Date.now() + 3600000,
    });
    const original = built.userModelCredentials.derivedOAuth.bind(built.userModelCredentials);
    const auth = mock.method(
      built.userModelCredentials,
      "derivedOAuth",
      async (user: string, provider: import("../src/model/pi-models.ts").ModelProvider) => {
        assert.equal(provider, "anthropic");
        return original(user, provider);
      },
    );
    const result = await built.app.turn({
      surface: "cron",
      actor: { externalId: "internal:alice" },
      conversation: { kind: "dm", threadRef: "claude-cron-codex-project" },
      origin: { kind: "automation", useOwnerModelAuth: true },
      triggered: true,
      text: "Check authentication",
      harness: "claude",
      model: "claude-opus-5-5",
      skipMemory: true,
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(claudeSeen.at(-1)?.runtime?.modelId, "claude-opus-5-5");
    assert.ok(auth.mock.callCount() > 0);
    auth.mock.restore();
  } finally {
    await built.runtime.stop();
  }
});

test("a session's saved model reaches a ChatGPT-subscription user's non-web turns, and a web pin saves and clears it", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
  const start = seen.length;
  try {
    await built.config.setPersonalModelAuth("internal:alice", true, "openai");
    built.config.setApprovedHarnesses(["mock", "pi", "claude"]);
    await built.config.flushScope("org:default-org");
    await built.userModelCredentials.setOAuth("internal:alice", "openai", {
      accessToken: "test-access",
      idToken: "test-id",
      accountId: "test-account",
      expiresAt: Date.now() + 3600000,
    });
    const chat = {
      surface: "discord",
      liveActor: true,
      actor: { externalId: "internal:alice" },
      conversation: { kind: "dm" as const, threadRef: "discord:dm:500000000000000001" },
      text: "hello",
      skipMemory: true,
    };
    assert.equal((await built.app.turn(chat)).status, "ok");
    assert.notEqual(seen.at(-1)?.runtime?.modelId, "codex/gpt-6-astra");
    const session = (await built.sessions.getByThread(chat.conversation.threadRef))!;
    await built.sessions.setRuntime(session.id, { harnessId: "pi", modelId: "codex/gpt-6-astra" });
    assert.equal((await built.app.turn({ ...chat, text: "again" })).status, "ok");
    assert.equal(seen.at(-1)?.runtime?.modelId, "codex/gpt-6-astra");
    assert.equal(seen.length - start, 2);

    const web = {
      surface: "web",
      liveActor: true,
      actor: { externalId: "internal:alice" },
      conversation: { kind: "dm" as const, threadRef: "web:internal:alice:pinned" },
      text: "pick astra",
      skipMemory: true,
    };
    const picked = await built.app.turn({ ...web, harness: "pi", model: "codex/gpt-6-astra", pinRuntime: true });
    assert.equal(picked.status, "ok", JSON.stringify(picked));
    const webSession = (await built.sessions.getByThread(web.conversation.threadRef))!;
    assert.deepEqual(
      { harnessId: webSession.runtime?.harnessId, modelId: webSession.runtime?.modelId },
      { harnessId: "pi", modelId: "codex/gpt-6-astra" },
    );
    assert.equal((await built.app.turn({ ...web, text: "back to default", pinRuntime: false })).status, "ok");
    assert.equal((await built.sessions.getByThread(web.conversation.threadRef))?.runtime, undefined);
    assert.notEqual(
      seen.at(-1)?.runtime?.modelId,
      "codex/gpt-6-astra",
      "the turn that clears the pin already uses the default",
    );

    await built.config.setPersonalModelAuth("internal:bob", true, "anthropic");
    await built.userModelCredentials.setOAuth("internal:bob", "anthropic", {
      accessToken: "bob-access",
      refreshToken: "bob-refresh",
      expiresAt: Date.now() + 3600000,
    });
    const thread = {
      surface: "discord",
      liveActor: true,
      conversation: {
        kind: "channel" as const,
        threadRef: "discord:ch:600000000000000001:800000000000000001",
        channelRef: "600000000000000001",
        audience: [{ externalId: "internal:alice" }, { externalId: "internal:bob" }],
      },
      skipMemory: true,
    };
    assert.equal(
      (await built.app.turn({ ...thread, actor: { externalId: "internal:alice" }, text: "hi" })).status,
      "ok",
    );
    const shared = (await built.sessions.getByThread(thread.conversation.threadRef))!;
    await built.sessions.setRuntime(shared.id, { harnessId: "pi", modelId: "codex/gpt-6-astra" });
    const claudeBefore = claudeSeen.length;
    const bob = await built.app.turn({ ...thread, actor: { externalId: "internal:bob" }, text: "my turn" });
    assert.equal(bob.status, "ok", JSON.stringify(bob));
    assert.equal(claudeSeen.length, claudeBefore + 1, "bob's turn runs on his own Claude subscription");
  } finally {
    await built.runtime.stop();
  }
});
