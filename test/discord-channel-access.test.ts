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
import { encodeRef, serviceCredRef } from "../src/acl/resource-ref.ts";

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

test("with DISCORD_TRUST_SERVER_MEMBERS, a live message in an allowed server's thread counts as company-only", async () => {
  for (const trusted of [false, true]) {
    const built = buildApp(
      testConfig({
        harness: "mock",
        seedSkills: false,
        discordGuildIds: ["700000000000000001"],
        ...(trusted ? { discordTrustServerMembers: true } : {}),
      }),
    );
    try {
      built.config.setInternalMemberOverrides(["alice@default-org"]);
      await built.config.flushScope("org:default-org");
      await built.serviceCreds.setServiceCredential("org:default-org", {
        slug: "safe",
        name: "safe",
        delivery: "env",
        envKey: "SAFE",
        secret: "SYNTHETIC_safe",
        host: "",
      });
      await built.acl.grant({
        ownerScopeId: "org:default-org",
        ref: encodeRef(serviceCredRef("safe")),
        granteeScopeId: "org:default-org",
        permission: "read",
        grantedBy: "alice@default-org",
      });
      await built.discordCore.rememberChannel("600000000000000009", "700000000000000001");
      for (const channel of ["600000000000000009", "600000000000000010"]) {
        const scope = `channel:${channel}` as const;
        const asSpeaker = built.sandboxResources.forTurn({
          actorId: "alice@default-org",
          scopeId: scope,
          isCurrent: async () => true,
        });
        const computer = await asSpeaker.create("alice@default-org", scope, built.sandboxResources.defaultBackend());
        await asSpeaker.setDefault("alice@default-org", scope, computer.id);
      }
      built.runtime.start();
      const seen: Array<{ env?: string; companyOnly: boolean }> = [];
      const run = built.sandbox.run.bind(built.sandbox);
      built.sandbox.run = async (handle, command, opts) => {
        seen.push({ env: handle.env?.SAFE, companyOnly: "BROWSE_LAB_MODEL" in (handle.env ?? {}) });
        return run(handle, command, opts);
      };
      const turn = async (channelRef: string, credentials: string[] = [], automated = false) => {
        const before = seen.length;
        await built.app.turn({
          surface: "discord",
          ...(automated ? { triggered: true } : { liveActor: true }),
          async: true,
          actor: { externalId: "alice@default-org" },
          conversation: {
            kind: "channel",
            threadRef: `discord:ch:${channelRef}:800000000000000009`,
            channelRef,
            audience: [{ externalId: "alice@default-org" }],
          },
          deliveryTarget: "800000000000000009",
          text: `!execute ${JSON.stringify({ command: "printf ok", credentials })}`,
          skipMemory: true,
        });
        const deadline = Date.now() + 3_000;
        while (seen.length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
        return seen.length > before ? seen.at(-1)! : null;
      };

      const room = await turn("600000000000000009");
      assert.ok(room, "a plain command runs either way");
      assert.equal(room.companyOnly, trusted, trusted ? "on: the room counts as company-only" : "off");
      const withKey = await turn("600000000000000009", ["safe"]);
      assert.equal(withKey?.env, trusted ? "SYNTHETIC_safe" : undefined, "the env credential rides only when on");

      const outside = await turn("600000000000000010");
      assert.equal(outside?.companyOnly, false, "a channel outside the allowed servers never counts");

      const scheduled = await turn("600000000000000009", ["safe"], true);
      assert.equal(scheduled?.env, undefined, "a scheduled job in the room never gets the env credential");
    } finally {
      await built.runtime.stop();
    }
  }
});
