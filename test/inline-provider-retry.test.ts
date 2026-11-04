import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ProviderTurnError } from "../src/core/turn-error.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { testConfig } from "./support/test-config.ts";

const pi = await import("../src/harness/pi-harness.ts");
let attempts = 0;
let firstAttemptStarted: Promise<void>;
let signalFirstAttempt: () => void;
function resetFirstAttemptSignal(): void {
  firstAttemptStarted = new Promise((resolve) => {
    signalFirstAttempt = resolve;
  });
}
resetFirstAttemptSignal();
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
          runTurn: async (_turn: HarnessTurnInput) => {
            attempts++;
            if (attempts === 1) {
              signalFirstAttempt();
              throw new ProviderTurnError("temporary OAuth refresh miss", {
                code: "auth",
                retryable: true,
                raw: "refresh returned no access token",
              });
            }
            return { reply: "recovered after retry", modelCalls: 1 };
          },
        },
      };
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

test("a synchronous turn stays attached when its provider failure is requeued", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  attempts = 0;
  resetFirstAttemptSignal();
  const built = buildApp(
    testConfig({
      harness: "pi",
      openaiApiKey: "company-test-key",
      runWaitMs: 60_000,
      seedSkills: false,
    }),
  );

  const pending = built.app.turn({
    surface: "test",
    actor: { externalId: "internal:alice" },
    conversation: { kind: "dm", threadRef: "inline-provider-retry" },
    text: "hello",
    idempotencyKey: "inline-provider-retry",
    skipMemory: true,
  });

  await firstAttemptStarted;
  assert.equal(attempts, 1);
  for (let i = 0; i < 100; i++) {
    const run = await built.runs.getByDedupKey("inline-provider-retry");
    if (run?.status === "pending" && run.errorAttempts === 1) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal((await built.runs.getByDedupKey("inline-provider-retry"))?.errorAttempts, 1);
  t.mock.timers.tick(30_000);
  const result = await pending;
  assert.equal(result.status, "ok");
  assert.equal(result.reply, "recovered after retry");
  assert.equal(attempts, 2);
});
