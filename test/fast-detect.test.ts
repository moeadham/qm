import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { HarnessDetectInput, HarnessDetectResult } from "../src/harness/harness.ts";
import { testConfig } from "./support/test-config.ts";

let fastVerdict: HarnessDetectResult = { respond: true };
const fastSeen: string[] = [];
const pi = await import("../src/harness/pi-harness.ts");
mock.module("../src/harness/pi-harness.ts", {
  namedExports: {
    ...pi,
    createPiHarness: (...args: Parameters<typeof pi.createPiHarness>) => {
      const harness = pi.createPiHarness(...args);
      return {
        ...harness,
        models: {
          ...harness.models,
          shouldRespond: async (input: HarnessDetectInput) => {
            fastSeen.push(input.message);
            return fastVerdict;
          },
        },
      };
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

const thread = {
  surface: "discord",
  liveActor: true,
  actor: { externalId: "internal:alice" },
  conversation: {
    kind: "channel" as const,
    threadRef: "discord:ch:600000000000000008:800000000000000008",
    channelRef: "600000000000000008",
    audience: [{ externalId: "internal:alice" }],
  },
  deliveryTarget: "800000000000000008",
  skipMemory: true,
  origin: { kind: "ambient" as const, live: true as const },
};

test("with a detect model configured, the fast model decides whether to answer, and the harness check covers it when it can't", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false, detectModelId: "fast-detect" }));
  try {
    fastVerdict = { respond: true, reason: "fast" };
    await built.app.turn({ ...thread, text: "nice weather" });
    assert.deepEqual(fastSeen, ["nice weather"]);
    assert.equal((await built.deliveries.pending("discord")).length, 1, "the fast model said answer");

    fastVerdict = { respond: false, reason: "fast" };
    await built.app.turn({ ...thread, text: "what model are you?" });
    assert.equal((await built.deliveries.pending("discord")).length, 1, "the fast model said stay quiet");

    fastVerdict = { respond: false, undecided: true };
    await built.app.turn({ ...thread, text: "and what harness?" });
    assert.equal((await built.deliveries.pending("discord")).length, 2, "the harness check answered the question");
    assert.equal(fastSeen.length, 3);
  } finally {
    await built.runtime.stop();
  }
});

test("without a detect model the harness check decides alone", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
  try {
    fastSeen.length = 0;
    await built.app.turn({ ...thread, text: "what model are you?" });
    assert.deepEqual(fastSeen, []);
    assert.equal((await built.deliveries.pending("discord")).length, 1);
  } finally {
    await built.runtime.stop();
  }
});
