import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIInteraction } from "@discordjs/core";
import { startDiscordPlugin, assertOneChatPlatform, discordConfigFromEnv } from "../src/discord/index.ts";
import { createDiscordCoreClient, type DiscordCoreClient } from "../src/discord/core.ts";
import {
  createDiscordGateway,
  type DiscordApi,
  type DiscordChannel,
  type DiscordGatewayHandlers,
  type DiscordMessage,
} from "../src/discord/api.ts";
import { verifyDiscordLinkTicket } from "../src/identity/discord-link.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import type { StagedEnvelope } from "../src/surfaces/envelope-staging.ts";
import type { Delivery, TurnRequest, TurnResult } from "../src/types.ts";
import type { RunHooks } from "../src/surfaces/surface-core-client.ts";

const BOT = "900000000000000001";
const ALICE = "100000000000000001";
const MALLORY = "100000000000000002";
const GUILD = "700000000000000001";
const OTHER_GUILD = "700000000000000002";
const CHANNEL = "600000000000000001";
const DM = "500000000000000001";
const SECRET = "test-signing-secret";

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function sharedLease(): LeaderLease {
  const held = new Set<string>();
  return {
    async hold(key, fn) {
      if (held.has(key)) return null;
      held.add(key);
      try {
        return await fn(new Promise(() => {}));
      } finally {
        held.delete(key);
      }
    },
  };
}

class FakeDiscord implements DiscordApi {
  sent: Array<{ channelId: string; content: string; id: string; nonce?: string }> = [];
  edits: Array<{ channelId: string; messageId: string; content: string }> = [];
  threads: Array<{ channelId: string; messageId: string; name: string }> = [];
  ephemeral: string[] = [];
  channels = new Map<string, DiscordChannel>();
  history = new Map<string, DiscordMessage[]>();
  dmFor = new Map<string, string>();
  private next = 1;

  async me() {
    return { id: BOT, username: "qm" };
  }
  async send(channelId: string, content: string, opts: { nonce?: string } = {}) {
    const id = `msg-${this.next++}`;
    this.sent.push({ channelId, content, id, ...(opts.nonce ? { nonce: opts.nonce } : {}) });
    return id;
  }
  async edit(channelId: string, messageId: string, content: string) {
    if (this.failEdits > 0) {
      this.failEdits--;
      throw Object.assign(new Error("Internal Server Error"), { status: 500 });
    }
    this.edits.push({ channelId, messageId, content });
  }
  removed: string[] = [];
  threadExists = false;
  async remove(_channelId: string, messageId: string) {
    this.removed.push(messageId);
  }
  async typing() {}
  async openDm(userId: string) {
    const dm = this.dmFor.get(userId) ?? `dm-${userId}`;
    this.dmFor.set(userId, dm);
    return dm;
  }
  async startThread(channelId: string, messageId: string, name: string) {
    if (this.threadExists) throw Object.assign(new Error("thread exists"), { code: 160004 });
    this.threads.push({ channelId, messageId, name });
    return messageId;
  }
  async channel(channelId: string) {
    const c = this.channels.get(channelId);
    if (!c) throw new Error(`unknown channel ${channelId}`);
    return c;
  }
  async recentMessages(channelId: string) {
    return this.history.get(channelId) ?? [];
  }
  async registerCommands() {}
  failEdits = 0;
  async deferEphemeral() {}
  async editReply(_token: string, content: string) {
    this.ephemeral.push(content);
  }
}

function fakeGateway(mode: "ready" | "hang" | "fatal" = "ready") {
  const g = {
    connects: 0,
    closes: 0,
    handlers: undefined as DiscordGatewayHandlers | undefined,
    open(handlers: DiscordGatewayHandlers) {
      g.connects++;
      g.handlers = handlers;
      return {
        ready: mode === "ready" ? Promise.resolve() : new Promise<void>(() => {}),
        closed: mode === "fatal" ? Promise.resolve(new Error("Used disallowed intents")) : new Promise<Error>(() => {}),
        close: async () => {
          g.closes++;
        },
      };
    },
  };
  return g;
}

interface Harness {
  core: DiscordCoreClient;
  turns: TurnRequest[];
  acked: string[];
  editRefs: Array<[string, string]>;
  stopped: string[];
  deliveriesAcked: Array<{ id: string; body?: unknown }>;
  queue: Delivery[];
}

function harness(opts: {
  linked?: Record<string, string>;
  lease?: LeaderLease;
  result?: (body: TurnRequest) => TurnResult;
  snapshots?: string[];
}): Harness {
  const linked = opts.linked ?? { [ALICE]: "alice@example.com" };
  const h: Harness = {
    turns: [],
    acked: [],
    editRefs: [],
    stopped: [],
    deliveriesAcked: [],
    queue: [],
    core: undefined as unknown as DiscordCoreClient,
  };
  const real = createDiscordCoreClient({
    app: {} as never,
    blobTransfer: {} as never,
    deliveries: { onEnqueue: () => () => {} } as never,
    metrics: {} as never,
    runs: { onTerminal: () => {} } as never,
    turnStream: {} as never,
    stagedEnvelopes: createMemoryMap<StagedEnvelope>(),
    ...(opts.lease ? { leaderLease: opts.lease } : {}),
    identity: {
      classify: (id: string) => {
        const user = id.replace(/^discord:/, "");
        return linked[user] ? { id: linked[user]!, type: "internal" } : { id, type: "guest" };
      },
      isInternal: (p: { type: string }) => p.type === "internal",
      refresh: async () => {},
    } as never,
    principalLinks: { unlink: async () => null },
    linkPrompts: createRateLimiter({ maxPerWindow: 1, windowMs: 60_000 }),
    orgId: "acme",
    signingSecret: SECRET,
    portalUrl: "https://qm.example.com/",
  });
  h.core = {
    ...real,
    async submitTurn(body) {
      h.turns.push({ ...body, surface: "discord" });
      return { status: "queued", runId: `run-${h.turns.length}` };
    },
    async waitRun(runId: string, hooks: RunHooks = {}) {
      for (const s of opts.snapshots ?? []) {
        hooks.onSnapshot?.(s);
        await new Promise((r) => setTimeout(r, 5));
      }
      return opts.result ? opts.result(h.turns.at(-1)!) : { status: "ok", reply: "hello back", runId };
    },
    async ackRunDelivery(runId) {
      h.acked.push(runId);
    },
    async reportRunEditRef(runId, editRef) {
      h.editRefs.push([runId, editRef]);
    },
    async stopConversation(threadRef) {
      h.stopped.push(threadRef);
      return true;
    },
    async claimDeliveries(type) {
      const rows = h.queue.filter((d) => d.destination.type === type && d.deliveredAt === null);
      return rows;
    },
    async ackDelivery(id, body) {
      h.deliveriesAcked.push({ id, body });
      const row = h.queue.find((d) => d.id === id);
      if (row) row.deliveredAt = Date.now();
    },
  };
  return h;
}

const cfg = { botToken: "t", applicationId: "app", guildIds: new Set([GUILD]) };

function dm(author: string, content: string, id = "m1"): DiscordMessage {
  return {
    id,
    channel_id: DM,
    content,
    timestamp: "2026-11-03T10:00:00.000Z",
    mentions: [],
    author: { id: author, username: author === ALICE ? "alice" : "mallory", global_name: null },
  };
}

async function boot(h: Harness, api = new FakeDiscord(), gateway = fakeGateway()) {
  const plugin = await startDiscordPlugin(cfg, h.core, { api, gateway });
  await until(() => gateway.handlers !== undefined, "gateway connect");
  return { api, gateway, plugin, handlers: gateway.handlers! };
}

test("a linked user's DM becomes a personal turn and a long reply is split at 2,000 characters", async () => {
  const long = `${"a".repeat(1_500)}\n\n${"b".repeat(1_500)}`;
  const h = harness({ result: () => ({ status: "ok", reply: long }) });
  const { api, handlers, plugin } = await boot(h);
  handlers.onMessage(dm(ALICE, "what's up?"));
  await until(() => h.acked.length === 1, "run delivery ack");
  await plugin.stop();

  const turn = h.turns[0]!;
  assert.equal(turn.surface, "discord");
  assert.equal(turn.actor.externalId, `discord:${ALICE}`);
  assert.deepEqual(turn.conversation, {
    kind: "dm",
    threadRef: `discord:dm:${DM}`,
    audience: [{ externalId: `discord:${ALICE}`, displayName: "alice" }],
  });
  assert.equal(turn.deliveryTarget, DM);
  assert.equal(turn.text, "what's up?");
  assert.ok(api.sent.length >= 2);
  assert.ok(api.sent.every((m) => m.content.length <= 2_000 && m.channelId === DM && m.nonce));
  assert.equal(new Set(api.sent.map((m) => m.nonce)).size, api.sent.length);
  assert.ok(api.sent.map((m) => m.content).join("") === long, "the chunks reassemble the full reply");
  assert.deepEqual(h.acked, ["run-1"]);
});

test("an unlinked user gets one link prompt DM carrying a ticket for their Discord id, and no turn", async () => {
  const h = harness({});
  const { api, handlers, plugin } = await boot(h);
  handlers.onMessage(dm(MALLORY, "hi", "m1"));
  await until(() => api.sent.length === 1, "link prompt");
  handlers.onMessage(dm(MALLORY, "hello?", "m2"));
  await new Promise((r) => setTimeout(r, 50));
  await plugin.stop();

  assert.equal(h.turns.length, 0);
  assert.equal(api.sent.length, 1);
  assert.equal(api.sent[0]!.channelId, `dm-${MALLORY}`);
  const url = new URL(api.sent[0]!.content.split(" ").at(-1)!);
  assert.equal(`${url.origin}${url.pathname}`, "https://qm.example.com/connect/discord");
  assert.equal(await verifyDiscordLinkTicket(url.searchParams.get("t")!, "acme", SECRET), MALLORY);
});

test("in servers the bot answers mentions in a new thread and ignores unmentioned and non-allowlisted messages", async () => {
  const h = harness({});
  const api = new FakeDiscord();
  api.channels.set(CHANNEL, { id: CHANNEL, type: 0, name: "general", guildId: GUILD });
  api.channels.set("600000000000000002", { id: "600000000000000002", type: 0, guildId: OTHER_GUILD });
  const { handlers, plugin } = await boot(h, api);
  const base = { ...dm(ALICE, ""), channel_id: CHANNEL, guild_id: GUILD };
  handlers.onMessage({ ...base, id: "800000000000000001", content: "just chatting" });
  handlers.onMessage({
    ...base,
    id: "800000000000000002",
    channel_id: "600000000000000002",
    guild_id: OTHER_GUILD,
    content: `<@${BOT}> hi`,
    mentions: [{ id: BOT } as never],
  });
  handlers.onMessage({
    ...base,
    id: "800000000000000003",
    content: `<@${BOT}> summarize this`,
    mentions: [{ id: BOT } as never],
  });
  await until(() => h.acked.length === 1, "thread reply");
  await plugin.stop();

  assert.equal(h.turns.length, 1);
  const turn = h.turns[0]!;
  assert.deepEqual(api.threads, [{ channelId: CHANNEL, messageId: "800000000000000003", name: "@qm summarize this" }]);
  assert.equal(turn.conversation.kind, "channel");
  assert.equal(turn.conversation.threadRef, `discord:ch:${CHANNEL}:800000000000000003`);
  assert.equal(turn.conversation.channelRef, CHANNEL);
  assert.equal(turn.deliveryTarget, "800000000000000003");
  assert.equal(turn.text, "@qm summarize this");
  assert.deepEqual(turn.origin, { kind: "human" });
});

test("a reply in a thread the bot owns is heard without a mention as an ambient turn", async () => {
  const h = harness({ result: () => ({ status: "silent" }) });
  const api = new FakeDiscord();
  const thread = "800000000000000009";
  api.channels.set(thread, { id: thread, type: 11, parentId: CHANNEL, ownerId: BOT, guildId: GUILD });
  api.history.set(thread, [
    {
      ...dm(BOT, "earlier answer", "800000000000000008"),
      channel_id: thread,
      author: { id: BOT, username: "qm", global_name: null, bot: true },
    },
  ]);
  const { handlers, plugin } = await boot(h, api);
  handlers.onMessage({
    ...dm(ALICE, "thanks, one more thing"),
    channel_id: thread,
    guild_id: GUILD,
    id: "800000000000000010",
  });
  await until(() => h.turns.length === 1, "ambient turn");
  await new Promise((r) => setTimeout(r, 20));
  await plugin.stop();

  const turn = h.turns[0]!;
  assert.deepEqual(turn.origin, { kind: "ambient", live: true });
  assert.equal(turn.conversation.threadRef, `discord:ch:${CHANNEL}:${thread}`);
  assert.equal(turn.priorTurns?.length, 1);
  assert.equal(turn.priorTurns?.[0]?.role, "assistant");
  assert.match(turn.priorTurns?.[0]?.text ?? "", /earlier answer$/);
  assert.equal(api.threads.length, 0);
  assert.equal(api.sent.length, 0);
  assert.deepEqual(h.acked, []);
});

test("a streamed reply posts one placeholder, edits it as text grows, records it as the run's edit ref, and finishes in place", async () => {
  const h = harness({ snapshots: ["Thinking", "Thinking about it"], result: () => ({ status: "ok", reply: "Done." }) });
  const { api, handlers, plugin } = await boot(h);
  handlers.onMessage(dm(ALICE, "go"));
  await until(() => h.acked.length === 1, "ack");
  await plugin.stop();

  assert.equal(api.sent.length, 1);
  assert.equal(api.sent[0]!.content, "Thinking");
  assert.deepEqual(h.editRefs, [["run-1", api.sent[0]!.id]]);
  assert.deepEqual(
    api.edits.map((e) => e.content),
    ["Thinking about it", "Done."],
  );
});

test("the gateway connects on exactly one instance while another holds the lease", async () => {
  const lease = sharedLease();
  const first = fakeGateway();
  const second = fakeGateway();
  const a = await startDiscordPlugin(cfg, harness({ lease }).core, { api: new FakeDiscord(), gateway: first });
  await until(() => first.connects === 1, "first connect");
  const b = await startDiscordPlugin(cfg, harness({ lease }).core, { api: new FakeDiscord(), gateway: second });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(second.connects, 0);
  await a.stop();
  assert.equal(first.closes, 1);
  await b.stop();
});

test("the delivery poller posts discord rows into place and DMs principals through their linked account", async () => {
  const h = harness({});
  installPrincipalLinks({
    canonical: (key) => (key === `discord:${ALICE}` ? "alice@example.com" : undefined),
    aliases: (key) => (key === "alice@example.com" ? [`discord:${ALICE}`] : []),
  });
  const old = Date.now() - 60_000;
  const row = (id: string, destination: Delivery["destination"], text: string, key = id): Delivery => ({
    id,
    destination,
    text,
    idempotencyKey: key,
    createdAt: old,
    deliveredAt: null,
  });
  h.queue.push(
    row("d1", { type: "discord", target: "thread-1", editRef: "placeholder-1" }, "recovered reply", "run:r9"),
    row("d2", { type: "principal", target: "alice@example.com" }, "a note for you"),
  );
  const api = new FakeDiscord();
  try {
    const { plugin } = await boot(h, api);
    await until(() => h.deliveriesAcked.length === 2, "deliveries acked");
    await plugin.stop();
  } finally {
    installPrincipalLinks(null);
  }

  assert.deepEqual(api.edits, [{ channelId: "thread-1", messageId: "placeholder-1", content: "recovered reply" }]);
  assert.deepEqual(
    api.sent.map((m) => [m.channelId, m.content]),
    [[`dm-${ALICE}`, "a note for you"]],
  );
  assert.deepEqual(h.deliveriesAcked.find((d) => d.id === "d2")?.body, {
    recipientThreadRef: `discord:dm:dm-${ALICE}`,
  });
});

function command(sub: string, user: string, channelId: string, guildId?: string): APIInteraction {
  return {
    id: "i1",
    token: "tok",
    type: 2,
    data: { name: "qm", options: [{ name: sub, type: 1 }] },
    channel: { id: channelId },
    ...(guildId ? { guild_id: guildId, member: { user: { id: user } } } : { user: { id: user } }),
  } as unknown as APIInteraction;
}

test("/qm link replies with a link for unlinked users and /qm stop stops the conversation where it runs", async () => {
  const h = harness({});
  const api = new FakeDiscord();
  api.channels.set(DM, { id: DM, type: 1 });
  api.channels.set(CHANNEL, { id: CHANNEL, type: 0, guildId: OTHER_GUILD });
  const { handlers, plugin } = await boot(h, api);
  handlers.onInteraction(command("link", MALLORY, DM));
  handlers.onInteraction(command("stop", ALICE, DM));
  handlers.onInteraction(command("stop", MALLORY, DM));
  handlers.onInteraction(command("stop", ALICE, CHANNEL, OTHER_GUILD));
  await until(() => api.ephemeral.length === 4, "ephemeral replies");
  await plugin.stop();

  assert.match(
    api.ephemeral.find((m) => m.startsWith("Link your account"))!,
    /connect\/discord\?t=/,
  );
  assert.deepEqual(h.stopped, [`discord:dm:${DM}`]);
  assert.ok(api.ephemeral.includes("Link your Discord account first with `/qm link`."));
  assert.ok(api.ephemeral.includes("QM isn't enabled in this server."));
});

test("an instance refuses to run both chat platforms and rejects partial Discord config", () => {
  const discord = discordConfigFromEnv({
    DISCORD_BOT_TOKEN: "t",
    DISCORD_APPLICATION_ID: "a",
    DISCORD_GUILD_IDS: `${GUILD}, `,
  });
  assert.deepEqual(discord?.guildIds, new Set([GUILD]));
  assert.throws(() => assertOneChatPlatform(discord, true), /one chat platform/);
  assert.doesNotThrow(() => assertOneChatPlatform(discord, false));
  assert.equal(discordConfigFromEnv({}), null);
  assert.throws(() => discordConfigFromEnv({ DISCORD_BOT_TOKEN: "t", DISCORD_APPLICATION_ID: "a" }), /GUILD_IDS/);
});

test("a failed streaming edit does not stop the final reply from landing in the placeholder", async () => {
  const h = harness({
    snapshots: ["one", "one two", "one two three"],
    result: () => ({ status: "ok", reply: "Final." }),
  });
  const api = new FakeDiscord();
  api.failEdits = 1;
  const { handlers, plugin } = await boot(h, api);
  handlers.onMessage(dm(ALICE, "go"));
  await until(() => h.acked.length === 1, "ack");
  await plugin.stop();

  assert.equal(api.sent.length, 1);
  assert.equal(api.edits.at(-1)?.messageId, api.sent[0]!.id);
  assert.equal(api.edits.at(-1)?.content, "Final.");
});

test("stop returns while the gateway is still connecting, and closes that connection", async () => {
  const gateway = fakeGateway("hang");
  const plugin = await startDiscordPlugin(cfg, harness({}).core, { api: new FakeDiscord(), gateway });
  await until(() => gateway.connects === 1, "connect attempt");
  const stopped = await Promise.race([
    plugin.stop().then(() => true),
    new Promise((r) => setTimeout(() => r(false), 500)),
  ]);
  assert.equal(stopped, true);
  assert.equal(gateway.closes, 1);
});

test("a fatal gateway close releases the connection and backs off instead of reconnecting every sweep", async () => {
  const gateway = fakeGateway("fatal");
  const plugin = await startDiscordPlugin(cfg, harness({}).core, { api: new FakeDiscord(), gateway });
  await until(() => gateway.closes === 1, "fatal close");
  await new Promise((r) => setTimeout(r, 6_000));
  await plugin.stop();
  assert.equal(gateway.connects, 1);
});

test("a gateway closed while it is still fetching its URL never starts a session", async () => {
  const rest = {
    async get() {
      await new Promise((r) => setTimeout(r, 100));
      return {
        url: "ws://127.0.0.1:9",
        shards: 1,
        session_start_limit: { remaining: 10, reset_after: 1_000, max_concurrency: 1, total: 1_000 },
      };
    },
  };
  const connection = createDiscordGateway("token", rest as never).open({ onMessage() {}, onInteraction() {} });
  await new Promise((r) => setTimeout(r, 20));
  await connection.close();
  await assert.rejects(connection.ready, /closed while connecting/);
});

test("when a person already opened a thread on the mention, the bot replies there without claiming it", async () => {
  const h = harness({ result: () => ({ status: "silent" }) });
  const api = new FakeDiscord();
  api.threadExists = true;
  const mention = "800000000000000020";
  api.channels.set(CHANNEL, { id: CHANNEL, type: 0, name: "general", guildId: GUILD });
  api.channels.set(mention, { id: mention, type: 11, parentId: CHANNEL, ownerId: ALICE, guildId: GUILD });
  const { handlers, plugin } = await boot(h, api);
  const base = { ...dm(ALICE, ""), channel_id: CHANNEL, guild_id: GUILD };
  handlers.onMessage({ ...base, id: mention, content: `<@${BOT}> hi`, mentions: [{ id: BOT } as never] });
  await until(() => h.turns.length === 1, "mention turn");
  handlers.onMessage({ ...base, channel_id: mention, id: "800000000000000021", content: "chatting among ourselves" });
  await new Promise((r) => setTimeout(r, 50));
  await plugin.stop();

  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0]!.deliveryTarget, mention);
  assert.doesNotMatch(h.turns[0]!.conversationHeader ?? "", /thread you started/);
  assert.match(h.turns[0]!.conversationHeader ?? "", /replying in a thread/);
});

test("a streamed placeholder is removed when the finished turn has no text to show", async () => {
  const h = harness({ snapshots: ["drafting"], result: () => ({ status: "ok", reply: "" }) });
  const { api, handlers, plugin } = await boot(h);
  handlers.onMessage(dm(ALICE, "make me a file"));
  await until(() => h.acked.length === 1, "ack");
  await plugin.stop();
  assert.deepEqual(api.removed, [api.sent[0]!.id]);
});
