import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import {
  createDiscordChannels,
  withDiscordChannels,
  type DiscordChannelRecord,
} from "../src/discord/channel-directory.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { testConfig } from "./support/test-config.ts";

test("a Discord server channel the bot has seen works like a public channel for every linked person", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false, discordGuildIds: ["700000000000000001"] }));
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
    await built.discordCore.rememberChannel("600000000000000005", "700000000000000002");
    assert.equal(await allowed("alice@default-org", "600000000000000005"), false, "a server that isn't allowed");
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

test("a channel from a server later removed from the allowed list stops counting", async () => {
  const store = createMemoryMap<DiscordChannelRecord>();
  await createDiscordChannels(store, new Set(["700000000000000001"])).remember(
    "600000000000000006",
    "700000000000000001",
  );
  assert.equal(await createDiscordChannels(store, new Set(["700000000000000001"])).has("600000000000000006"), true);
  assert.equal(await createDiscordChannels(store, new Set(["700000000000000009"])).has("600000000000000006"), false);
});

test("the Slack directory's answer wins over a Discord record, and deactivated people are not members", async () => {
  const channels = { has: async () => true, remember: async () => {} };
  const slack = { ...createDirectoryStore(), channelPrivacy: async () => true, channelMember: async () => false };
  const directory = withDiscordChannels(slack, channels, (id) => id === "alice@default-org");
  assert.equal(await directory.channelPrivacy("C0PRIVATE"), true);
  assert.equal(await directory.channelMember("C0PRIVATE", "alice@default-org"), false);

  const unknownToSlack = withDiscordChannels(createDirectoryStore(), channels, (id) => id === "alice@default-org");
  assert.equal(await unknownToSlack.channelMember("600000000000000007", "alice@default-org"), true);
  assert.equal(await unknownToSlack.channelMember("600000000000000007", "former@default-org"), false);
});
