import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("an overheard thread message QM chose to answer delivers its plain-text reply", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
  try {
    const thread = {
      surface: "discord",
      liveActor: true,
      actor: { externalId: "internal:alice" },
      conversation: {
        kind: "channel" as const,
        threadRef: "discord:ch:600000000000000002:800000000000000002",
        channelRef: "600000000000000002",
        audience: [{ externalId: "internal:alice" }],
      },
      deliveryTarget: "800000000000000002",
      skipMemory: true,
    };
    const quiet = await built.app.turn({ ...thread, origin: { kind: "ambient", live: true }, text: "nice weather" });
    assert.equal(quiet.status, "silent", JSON.stringify(quiet));
    assert.deepEqual(await built.deliveries.pending("discord"), []);

    const answered = await built.app.turn({
      ...thread,
      origin: { kind: "ambient", live: true },
      text: "what model are you?",
    });
    assert.equal(answered.status, "silent", JSON.stringify(answered));
    const posted = await built.deliveries.pending("discord");
    assert.equal(posted.length, 1, JSON.stringify(posted));
    assert.ok(JSON.stringify(posted[0]).includes("what model are you"), JSON.stringify(posted[0]));

    const declined = await built.app.turn({ ...thread, origin: { kind: "ambient", live: true }, text: "!silent" });
    assert.equal(declined.status, "silent", JSON.stringify(declined));
    assert.equal(
      (await built.deliveries.pending("discord")).length,
      1,
      "an overheard turn that ends quiet is not pushed to post",
    );
  } finally {
    await built.runtime.stop();
  }
});
