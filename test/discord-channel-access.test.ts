import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("a Discord server channel the bot has seen works like a public channel for every linked person", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
  try {
    built.config.setInternalMemberOverrides(["alice@default-org", "bob@default-org"]);
    await built.config.flushScope("org:default-org");
    const scope = (id: string) => `channel:${id}` as const;
    const allowed = (actorId: string, channel: string) =>
      built.app.authorizesCapabilityScope({ actorId, scopeId: scope(channel) });

    assert.equal(await allowed("alice@default-org", "600000000000000003"), false, "unseen channel");
    await built.discordCore.rememberChannel("600000000000000003", "700000000000000001");

    assert.equal(await allowed("alice@default-org", "600000000000000003"), true);
    assert.equal(
      await allowed("bob@default-org", "600000000000000003"),
      true,
      "every linked person, not only the speaker",
    );
    assert.equal(await allowed("discord:900000000000000009", "600000000000000003"), false, "an unlinked Discord user");
    assert.equal(await allowed("alice@default-org", "600000000000000004"), false, "another unseen channel");
    assert.equal(await built.directory.channelPrivacy("600000000000000003"), false);
    assert.equal(
      await built.directory.channelPrivacy("C0SLACK"),
      undefined,
      "Slack channels unknown to the directory stay unknown",
    );
  } finally {
    await built.runtime.stop();
  }
});
