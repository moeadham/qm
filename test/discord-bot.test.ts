import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import assert from "node:assert/strict";
import type { APIInteraction } from "@discordjs/core";
import { startDiscordPlugin, assertOneChatPlatform, discordConfigFromEnv } from "../src/discord/index.ts";
import { createDiscordCoreClient, type DiscordCoreClient } from "../src/discord/core.ts";
import {
  components,
  createDiscordGateway,
  type DiscordApi,
  type DiscordButton,
  type DiscordSelect,
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
import type { Delivery, SurfaceContextRequest, SurfaceContextResult, TurnRequest, TurnResult } from "../src/types.ts";
import type { RunHooks, StoredApprovalView } from "../src/surfaces/surface-core-client.ts";
import type { KeychainApprovalView } from "../src/credentials/keychain-approval.ts";
import type { RuntimeDeps } from "../src/api/runtime-config.ts";
import { buildApp } from "../src/wiring.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import { testConfig } from "./support/test-config.ts";

const BOT = "900000000000000001";
const ALICE = "100000000000000001";
const MALLORY = "100000000000000002";
const GUILD = "700000000000000001";
const OTHER_GUILD = "700000000000000002";
const CHANNEL = "600000000000000001";
const DM = "500000000000000001";
const SECRET = "test-signing-secret";

async function until(check: () => boolean, label: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
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
  sent: Array<{
    channelId: string;
    content: string;
    id: string;
    nonce?: string;
    buttons?: DiscordButton[];
    replyTo?: string;
  }> = [];
  edits: Array<{ channelId: string; messageId: string; content: string; buttons?: DiscordButton[] }> = [];
  deferredUpdates: string[] = [];
  threads: Array<{ channelId: string; messageId: string; name: string }> = [];
  ephemeral: string[] = [];
  channels = new Map<string, DiscordChannel>();
  history = new Map<string, DiscordMessage[]>();
  dmFor = new Map<string, string>();
  private next = 1;

  async me() {
    return { id: BOT, username: "qm" };
  }
  files: Array<{ channelId: string; names: string[]; bytes: string[]; replyTo?: string }> = [];
  async sendFiles(channelId: string, files: Array<{ name: string; data: Buffer }>, opts: { replyTo?: string } = {}) {
    this.files.push({
      channelId,
      names: files.map((f) => f.name),
      bytes: files.map((f) => f.data.toString()),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    });
    return `msg-${this.next++}`;
  }
  async send(
    channelId: string,
    content: string,
    opts: { nonce?: string; buttons?: DiscordButton[]; replyTo?: string } = {},
  ) {
    const id = `msg-${this.next++}`;
    this.sent.push({
      channelId,
      content,
      id,
      ...(opts.nonce ? { nonce: opts.nonce } : {}),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.buttons ? { buttons: opts.buttons } : {}),
    });
    return id;
  }
  async edit(channelId: string, messageId: string, content: string, opts: { buttons?: DiscordButton[] } = {}) {
    if (this.failEdits > 0) {
      this.failEdits--;
      throw Object.assign(new Error("Internal Server Error"), { status: 500 });
    }
    this.edits.push({ channelId, messageId, content, ...(opts.buttons ? { buttons: opts.buttons } : {}) });
  }
  removed: string[] = [];
  threadExists = false;
  async remove(_channelId: string, messageId: string) {
    this.removed.push(messageId);
  }
  typed: string[] = [];
  async typing(channelId: string) {
    this.typed.push(channelId);
  }
  async openDm(userId: string) {
    const dm = this.dmFor.get(userId) ?? `dm-${userId}`;
    this.dmFor.set(userId, dm);
    return dm;
  }
  async startThread(channelId: string, messageId: string, name: string) {
    if (this.threadExists) throw Object.assign(new Error("thread exists"), { code: 160004 });
    this.threads.push({ channelId, messageId, name });
    const parent = this.channels.get(channelId);
    this.channels.set(messageId, {
      id: messageId,
      type: 11,
      parentId: channelId,
      ...(parent?.guildId ? { guildId: parent.guildId } : {}),
    });
    return messageId;
  }
  async channel(channelId: string) {
    const c = this.channels.get(channelId);
    if (!c) throw new Error(`unknown channel ${channelId}`);
    return c;
  }
  historyReads: Array<[string, string | undefined]> = [];
  historyErrors = new Set<string>();
  historyGates = new Map<string, Promise<void>>();
  async recentMessages(channelId: string, _limit?: number, before?: string) {
    this.historyReads.push([channelId, before]);
    const gate = this.historyGates.get(channelId);
    this.historyGates.delete(channelId);
    await gate;
    if (this.historyErrors.has(channelId)) throw Object.assign(new Error("Missing Access"), { code: 50001 });
    return this.history.get(channelId) ?? [];
  }
  reactions: Array<[string, string, string]> = [];
  pins: Array<[string, string, boolean]> = [];
  reactionErrors = new Map<string, number>();
  async react(channelId: string, messageId: string, emoji: string) {
    const code = this.reactionErrors.get(emoji);
    if (code !== undefined) throw Object.assign(new Error(`discord ${code}`), { code });
    this.reactions.push([channelId, messageId, emoji]);
  }
  async pin(channelId: string, messageId: string, remove = false) {
    this.pins.push([channelId, messageId, remove]);
  }
  async message(channelId: string, messageId: string) {
    const found = (this.history.get(channelId) ?? []).find((m) => m.id === messageId);
    if (!found) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
    return found;
  }
  async registerCommands() {}
  failEdits = 0;
  async deferEphemeral() {}
  replies: Array<{ content: string; buttons?: DiscordButton[]; select?: DiscordSelect }> = [];
  async editReply(_token: string, content: string, opts: { buttons?: DiscordButton[]; select?: DiscordSelect } = {}) {
    this.ephemeral.push(content);
    this.replies.push({ content, ...opts });
  }
  suggestions: Array<Array<{ name: string; value: string }>> = [];
  async autocomplete(_id: string, _token: string, choices: Array<{ name: string; value: string }>) {
    this.suggestions.push(choices);
  }
  async deferUpdate(interactionId: string) {
    this.deferredUpdates.push(interactionId);
  }
  async followUpEphemeral(_token: string, content: string) {
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
  decisions: unknown[][];
  channels: Array<[string, string]>;
  blobs: Map<string, Buffer>;
  fulfilled: Array<{ id: string; result?: SurfaceContextResult; error?: string }>;
}

function harness(opts: {
  linked?: Record<string, string>;
  lease?: LeaderLease;
  result?: (body: TurnRequest) => TurnResult;
  snapshots?: string[];
  replying?: boolean;
  approvals?: Record<string, StoredApprovalView>;
  consumeApprovals?: boolean;
  keychain?: KeychainApprovalView;
  deployRequests?: Record<string, { deploymentId: string; requesterId: string }>;
  runtime?: RuntimeDeps;
  sessions?: SessionStore;
  contextRequests?: SurfaceContextRequest[];
  transcribe?: (audio: Uint8Array, filename: string, mimetype: string) => Promise<string>;
}): Harness {
  const linked = opts.linked ?? { [ALICE]: "alice@example.com" };
  const enqueued = new Set<() => void>();
  const queue: Delivery[] = [];
  queue.push = (...rows: Delivery[]) => {
    const size = Array.prototype.push.apply(queue, rows);
    for (const notify of enqueued) notify();
    return size;
  };
  const h: Harness = {
    turns: [],
    acked: [],
    editRefs: [],
    stopped: [],
    deliveriesAcked: [],
    queue,
    decisions: [],
    channels: [],
    blobs: new Map(),
    fulfilled: [],
    core: undefined as unknown as DiscordCoreClient,
  };
  const real = createDiscordCoreClient({
    app: {} as never,
    blobTransfer: {} as never,
    deliveries: {
      onEnqueue: (listener: () => void) => {
        enqueued.add(listener);
        return () => enqueued.delete(listener);
      },
    } as never,
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
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    sessions: opts.sessions ?? createMemorySessionStore(),
    discordChannels: { remember: async (channelId, guildId) => void h.channels.push([channelId, guildId]) },
    ...(opts.transcribe ? { transcribe: opts.transcribe } : {}),
  });
  h.core = {
    ...real,
    async submitTurn(body) {
      h.turns.push({ ...body, surface: "discord" });
      if (body.approval && opts.consumeApprovals) delete opts.approvals?.[body.approval.requestId];
      return { status: "queued", runId: `run-${h.turns.length}` };
    },
    async waitRun(runId: string, hooks: RunHooks = {}) {
      if (opts.replying) hooks.onReplying?.();
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
    async pendingContextRequests() {
      return opts.contextRequests ?? [];
    },
    onContextRequest() {
      return () => {};
    },
    async fulfillContextRequest(id, outcome) {
      h.fulfilled.push({ id, ...outcome });
    },
    async stageBlob(bytes) {
      const blobId = `blob-${h.blobs.size + 1}`;
      h.blobs.set(blobId, Buffer.from(bytes));
      return { blobId, sizeBytes: bytes.length };
    },
    async readBlob(blobId) {
      const blob = h.blobs.get(blobId);
      if (!blob) throw new Error(`blob ${blobId} not found`);
      return blob;
    },
    async claimDeliveries(type) {
      const rows = h.queue.filter((d) => d.destination.type === type && d.deliveredAt === null);
      return rows;
    },
    async getApproval(requestId) {
      return opts.approvals?.[requestId] ?? null;
    },
    async deploymentAccessRequest(deliveryId) {
      return opts.deployRequests?.[deliveryId];
    },
    async decideDeploymentAccess(request, actor, approve) {
      h.decisions.push(["deploy", request, actor.externalId, approve]);
      return approve ? "Approved. bob can now open the app." : "Declined.";
    },
    ...(opts.keychain
      ? {
          keychainApprovals: {
            get: async () => opts.keychain!,
            card: async () => opts.keychain!,
            decide: async (id, actor, decision) => {
              h.decisions.push(["keychain", id, actor.externalId, decision]);
              return { ...opts.keychain!, ask: { ...opts.keychain!.ask, status: "approved" }, mode: "once" };
            },
          },
        }
      : {}),
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
    type: 0,
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
  assert.deepEqual(turn.origin, { kind: "human", messageTs: "800000000000000003" });
});

test("a reply in a thread the bot owns is heard without a mention as an ambient turn", async () => {
  const h = harness({ result: () => ({ status: "silent" }) });
  const api = new FakeDiscord();
  const thread = "800000000000000009";
  api.channels.set(thread, { id: thread, type: 11, parentId: CHANNEL, ownerId: BOT, guildId: GUILD });
  api.history.set(thread, [
    {
      ...dm(BOT, "", "800000000000000007"),
      type: 21,
      channel_id: thread,
      author: { id: BOT, username: "qm", global_name: null, bot: true },
    },
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
  assert.deepEqual(turn.origin, { kind: "ambient", live: true, entryTs: "800000000000000010" });
  assert.equal(turn.conversation.threadRef, `discord:ch:${CHANNEL}:${thread}`);
  assert.equal(turn.priorTurns?.length, 1);
  assert.equal(turn.priorTurns?.[0]?.role, "assistant");
  assert.match(turn.priorTurns?.[0]?.text ?? "", /^\[800000000000000008\] earlier answer$/, "real Discord message ids");
  assert.equal(api.threads.length, 0);
  assert.equal(api.sent.length, 0);
  assert.deepEqual(h.acked, []);
  assert.deepEqual(api.typed, [], "a turn that stays quiet never shows typing");
});

test("in a thread a person started, follow-ups are heard without a mention once QM has a stake in it", async () => {
  const h = harness({ result: () => ({ status: "silent" }) });
  const api = new FakeDiscord();
  const joined = "800000000000000101";
  const mentioned = "800000000000000102";
  const strangers = "800000000000000103";
  for (const id of [joined, mentioned, strangers])
    api.channels.set(id, { id, type: 11, parentId: CHANNEL, ownerId: ALICE, guildId: GUILD });
  api.history.set(joined, [
    {
      ...dm(BOT, "here's what I found", "800000000000000104"),
      channel_id: joined,
      author: { id: BOT, username: "qm", global_name: null, bot: true },
    },
  ]);
  const { handlers, plugin } = await boot(h, api);
  const say = (thread: string, id: string, content: string, mention = false) =>
    handlers.onMessage({
      ...dm(ALICE, content, id),
      channel_id: thread,
      guild_id: GUILD,
      ...(mention ? { mentions: [{ id: BOT } as never] } : {}),
    });
  say(strangers, "800000000000000110", "just us here");
  say(joined, "800000000000000111", "and what about tuesday?");
  await until(() => h.turns.length === 1, "follow-up in a thread QM answered");
  say(mentioned, "800000000000000112", `<@${BOT}> can you check this`, true);
  await until(() => h.turns.length === 2, "mention");
  say(mentioned, "800000000000000113", "also the other one");
  await until(() => h.turns.length === 3, "follow-up after the mention");
  say(strangers, "800000000000000114", "still just us");
  await new Promise((r) => setTimeout(r, 20));
  await plugin.stop();

  assert.deepEqual(
    h.turns.map((t) => [t.deliveryTarget, t.origin]),
    [
      [joined, { kind: "ambient", live: true, entryTs: "800000000000000111" }],
      [mentioned, { kind: "human", messageTs: "800000000000000112" }],
      [mentioned, { kind: "ambient", live: true, entryTs: "800000000000000113" }],
    ],
  );
  assert.equal(api.historyReads.filter(([c]) => c === strangers).length, 1, "a thread without QM is checked once");
});

test("a thread QM can't read, or one hit by a burst of messages, is checked once", async () => {
  const h = harness({ result: () => ({ status: "silent" }) });
  const api = new FakeDiscord();
  const locked = "800000000000000131";
  const busy = "800000000000000132";
  for (const id of [locked, busy])
    api.channels.set(id, { id, type: 11, parentId: CHANNEL, ownerId: ALICE, guildId: GUILD });
  api.historyErrors.add(locked);
  const { handlers, plugin } = await boot(h, api);
  for (const [i, thread] of [locked, locked, busy, busy, busy].entries())
    handlers.onMessage({ ...dm(ALICE, "hey", `80000000000000014${i}`), channel_id: thread, guild_id: GUILD });
  await new Promise((r) => setTimeout(r, 50));
  await plugin.stop();
  assert.deepEqual(
    api.historyReads.map(([c]) => c),
    [locked, busy],
  );
  assert.equal(h.turns.length, 0);
});

test("a mention that lands while a thread is being checked isn't undone by the check", async () => {
  const h = harness({ result: () => ({ status: "silent" }) });
  const api = new FakeDiscord();
  const thread = "800000000000000171";
  api.channels.set(thread, { id: thread, type: 11, parentId: CHANNEL, ownerId: ALICE, guildId: GUILD });
  let release!: () => void;
  api.historyGates.set(thread, new Promise<void>((r) => (release = r)));
  const { handlers, plugin } = await boot(h, api);
  const say = (id: string, content: string, mention = false) =>
    handlers.onMessage({
      ...dm(ALICE, content, id),
      channel_id: thread,
      guild_id: GUILD,
      ...(mention ? { mentions: [{ id: BOT } as never] } : {}),
    });
  say("800000000000000172", "chatting");
  await until(() => api.historyReads.length === 1, "scan started");
  say("800000000000000173", `<@${BOT}> look at this`, true);
  await until(() => h.turns.length === 1, "mention");
  release();
  await new Promise((r) => setTimeout(r, 20));
  say("800000000000000174", "and this too");
  await until(() => h.turns.some((t) => t.deliveryTarget === thread && t.text === "and this too"), "follow-up heard");
  await plugin.stop();
  assert.deepEqual(h.turns.find((t) => t.text === "and this too")!.origin, {
    kind: "ambient",
    live: true,
    entryTs: "800000000000000174",
  });
});

test("once QM posts into a thread someone else started, replies there are heard", async () => {
  const h = harness({ result: () => ({ status: "silent" }) });
  const api = new FakeDiscord();
  const thread = "800000000000000151";
  api.channels.set(thread, { id: thread, type: 11, parentId: CHANNEL, ownerId: ALICE, guildId: GUILD });
  const { handlers, plugin } = await boot(h, api);
  handlers.onMessage({ ...dm(ALICE, "before", "800000000000000152"), channel_id: thread, guild_id: GUILD });
  await new Promise((r) => setTimeout(r, 20));
  h.queue.push({
    id: "d-post",
    destination: { type: "discord", target: thread },
    text: "Daily summary",
    idempotencyKey: "post:d-post",
    createdAt: Date.now() - 60_000,
    deliveredAt: null,
  });
  await until(() => h.deliveriesAcked.length === 1, "delivery");
  handlers.onMessage({
    ...dm(ALICE, "thanks, and the rest?", "800000000000000153"),
    channel_id: thread,
    guild_id: GUILD,
  });
  await until(() => h.turns.length === 1, "follow-up heard");
  await plugin.stop();
  assert.deepEqual(h.turns[0]!.origin, { kind: "ambient", live: true, entryTs: "800000000000000153" });
});

test("an unlinked bystander in a thread QM follows gets no link prompt", async () => {
  const h = harness({});
  const api = new FakeDiscord();
  const thread = "800000000000000161";
  api.channels.set(thread, { id: thread, type: 11, parentId: CHANNEL, ownerId: BOT, guildId: GUILD });
  const { handlers, plugin } = await boot(h, api);
  handlers.onMessage({ ...dm(MALLORY, "lol", "800000000000000162"), channel_id: thread, guild_id: GUILD });
  await new Promise((r) => setTimeout(r, 50));
  await plugin.stop();
  assert.deepEqual(api.sent, []);
  assert.equal(h.turns.length, 0);
});

test("a mention in the main channel gives QM the recent channel conversation", async () => {
  const h = harness({});
  const api = new FakeDiscord();
  api.channels.set(CHANNEL, { id: CHANNEL, type: 0, name: "general", guildId: GUILD });
  api.history.set(CHANNEL, [
    { ...dm(MALLORY, "the deploy failed again", "800000000000000120"), channel_id: CHANNEL, guild_id: GUILD },
  ]);
  const { handlers, plugin } = await boot(h, api);
  handlers.onMessage({
    ...dm(ALICE, `<@${BOT}> any idea why?`, "800000000000000121"),
    channel_id: CHANNEL,
    guild_id: GUILD,
    mentions: [{ id: BOT } as never],
  });
  await until(() => h.acked.length === 1, "reply");
  await plugin.stop();

  const turn = h.turns[0]!;
  assert.deepEqual(api.historyReads, [[CHANNEL, "800000000000000121"]]);
  assert.match(turn.priorTurns?.[0]?.text ?? "", /the deploy failed again/);
  assert.match(turn.conversationHeader ?? "", /top-level message/);
});

test("a forwarded message reaches QM with its text", async () => {
  const h = harness({});
  const { handlers, plugin } = await boot(h);
  handlers.onMessage({
    ...dm(ALICE, ""),
    message_snapshots: [{ message: { content: "the build is green", attachments: [] } }],
  });
  await until(() => h.turns.length === 1, "turn");
  await plugin.stop();
  assert.equal(h.turns[0]!.text, "(forwarded message) the build is green");
});

test("files in a forwarded message reach QM", async () => {
  const h = harness({});
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("PNGDATA", { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
  try {
    const { handlers, plugin } = await boot(h);
    handlers.onMessage({
      ...dm(ALICE, ""),
      message_snapshots: [
        {
          message: {
            content: "",
            attachments: [
              {
                id: "a1",
                filename: "chart.png",
                size: 7,
                url: "https://cdn.discordapp.com/attachments/1/2/chart.png",
                content_type: "image/png",
              },
            ],
          },
        },
      ],
    });
    await until(() => h.turns.length === 1, "turn");
    await plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(
    h.turns[0]!.attachments?.map((a) => a.name),
    ["chart.png"],
  );
});

test("a voice note reaches QM as its transcript, with the audio still attached", async () => {
  const heard: Array<[string, string, string]> = [];
  const h = harness({
    transcribe: async (audio, filename, mimetype) => {
      heard.push([Buffer.from(audio).toString(), filename, mimetype]);
      return "can you check the deploy";
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("OGGDATA", { headers: { "content-type": "audio/ogg" } })) as unknown as typeof fetch;
  try {
    const { handlers, plugin } = await boot(h);
    handlers.onMessage({
      ...dm(ALICE, ""),
      flags: 8192,
      attachments: [
        {
          id: "v1",
          filename: "voice-message.ogg",
          size: 7,
          url: "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg",
          content_type: "audio/ogg",
        },
      ],
    });
    await until(() => h.turns.length === 1, "turn");
    await plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(heard, [["OGGDATA", "voice-message.ogg", "audio/ogg"]]);
  assert.equal(h.turns[0]!.text, "(voice note) can you check the deploy");
  assert.deepEqual(
    h.turns[0]!.attachments?.map((a) => a.name),
    ["voice-message.ogg"],
  );
});

test("a voice note that can't be transcribed still reaches QM, with a note saying so", async () => {
  const h = harness({
    transcribe: async () => {
      throw new Error("http 402 out of credit");
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("OGGDATA", { headers: { "content-type": "audio/ogg" } })) as unknown as typeof fetch;
  try {
    const { handlers, plugin } = await boot(h);
    handlers.onMessage({
      ...dm(ALICE, ""),
      flags: 8192,
      attachments: [
        {
          id: "v2",
          filename: "voice-message.ogg",
          size: 7,
          url: "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg",
          content_type: "audio/ogg",
        },
      ],
    });
    await until(() => h.turns.length === 1, "turn");
    await plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(h.turns[0]!.inboundNotes?.join(" ") ?? "", /voice note that couldn't be transcribed/);
  assert.equal(h.turns[0]!.text, "");
  assert.deepEqual(
    h.turns[0]!.attachments?.map((a) => a.name),
    ["voice-message.ogg"],
  );
});

test("only a voice note QM handles is transcribed: not from unlinked people, unflagged audio, or unfollowed channels", async () => {
  let calls = 0;
  const h = harness({
    transcribe: async () => {
      calls++;
      return "hello";
    },
  });
  const api = new FakeDiscord();
  api.channels.set(CHANNEL, { id: CHANNEL, type: 0, name: "general", guildId: GUILD });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("OGGDATA", { headers: { "content-type": "audio/ogg" } })) as unknown as typeof fetch;
  const audio = {
    id: "v3",
    filename: "voice-message.ogg",
    size: 7,
    url: "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg",
    content_type: "audio/ogg",
  };
  try {
    const { handlers, plugin } = await boot(h, api);
    handlers.onMessage({ ...dm(MALLORY, "", "800000000000000201"), flags: 8192, attachments: [audio] });
    handlers.onMessage({ ...dm(ALICE, "", "800000000000000202"), attachments: [audio] });
    handlers.onMessage({
      ...dm(ALICE, "", "800000000000000203"),
      channel_id: CHANNEL,
      guild_id: GUILD,
      flags: 8192,
      attachments: [audio],
    });
    await until(() => h.turns.length === 1, "the unflagged DM file still reaches QM");
    await new Promise((r) => setTimeout(r, 50));
    await plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
  assert.equal(h.turns.length, 1);
});

test("markdown tables are sent as aligned code blocks", async () => {
  const h = harness({
    result: () => ({ status: "ok", reply: "Results:\n\n| name | score |\n|---|---|\n| alice | 10 |" }),
  });
  const { api, handlers, plugin } = await boot(h);
  handlers.onMessage(dm(ALICE, "scores?"));
  await until(() => h.acked.length === 1, "reply");
  await plugin.stop();
  assert.equal(api.sent[0]!.content, "Results:\n\n```\nname  | score\n------+------\nalice | 10\n```");
});

test("an unmentioned thread message shows typing once QM decides to answer it", async () => {
  const h = harness({ replying: true });
  const api = new FakeDiscord();
  const thread = "800000000000000019";
  api.channels.set(thread, { id: thread, type: 11, parentId: CHANNEL, ownerId: BOT, guildId: GUILD });
  const { handlers, plugin } = await boot(h, api);
  handlers.onMessage({
    ...dm(ALICE, "and the second one?"),
    channel_id: thread,
    guild_id: GUILD,
    id: "800000000000000020",
  });
  await until(() => api.sent.length === 1, "reply");
  await plugin.stop();

  assert.equal(api.sent[0]!.content, "hello back");
  assert.ok(api.typed.includes(thread));
});

test("an unmentioned thread message QM chose to answer reports its failure in the thread", async () => {
  const h = harness({
    replying: true,
    result: () => ({ status: "failed", reason: "Provider is not configured: openai-codex" }),
  });
  const api = new FakeDiscord();
  const thread = "800000000000000021";
  api.channels.set(thread, { id: thread, type: 11, parentId: CHANNEL, ownerId: BOT, guildId: GUILD });
  const { handlers, plugin } = await boot(h, api);
  handlers.onMessage({
    ...dm(ALICE, "what model are you?"),
    channel_id: thread,
    guild_id: GUILD,
    id: "800000000000000022",
  });
  await until(() => api.sent.length === 1, "failure note");
  await plugin.stop();

  assert.match(api.sent[0]!.content, /^⚠️ /);
});

test("an unmentioned thread message QM stayed quiet on posts nothing when it fails", async () => {
  const h = harness({ result: () => ({ status: "failed", reason: "boom" }) });
  const api = new FakeDiscord();
  const thread = "800000000000000023";
  api.channels.set(thread, { id: thread, type: 11, parentId: CHANNEL, ownerId: BOT, guildId: GUILD });
  const { handlers, plugin } = await boot(h, api);
  handlers.onMessage({ ...dm(ALICE, "nice"), channel_id: thread, guild_id: GUILD, id: "800000000000000024" });
  await until(() => h.turns.length === 1, "turn");
  await new Promise((r) => setTimeout(r, 30));
  await plugin.stop();

  assert.equal(api.sent.length, 0);
});

test("a message in a server thread records its channel so the agent can work in it", async () => {
  const h = harness({});
  const api = new FakeDiscord();
  const thread = "800000000000000025";
  api.channels.set(thread, { id: thread, type: 11, parentId: CHANNEL, ownerId: BOT, guildId: GUILD });
  const { handlers, plugin } = await boot(h, api);
  handlers.onMessage({ ...dm(ALICE, "hello"), channel_id: thread, guild_id: GUILD, id: "800000000000000026" });
  await until(() => h.turns.length === 1, "turn");
  handlers.onMessage(dm(ALICE, "a direct message"));
  await until(() => h.turns.length === 2, "dm turn");
  await plugin.stop();

  assert.deepEqual(h.channels, [[CHANNEL, GUILD]]);
});

test("an image sent to QM reaches the turn as a file, and a non-Discord link is refused", async () => {
  const h = harness({});
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    fetched.push(String(url));
    return new Response("PNGDATA", { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  try {
    const { handlers, plugin } = await boot(h);
    handlers.onMessage({
      ...dm(ALICE, ""),
      attachments: [
        {
          id: "a1",
          filename: "screen.png",
          size: 7,
          url: "https://cdn.discordapp.com/attachments/1/2/screen.png",
          content_type: "image/png",
        },
        { id: "a2", filename: "evil.png", size: 7, url: "https://example.com/evil.png", content_type: "image/png" },
      ],
    });
    await until(() => h.turns.length === 1, "turn");
    await plugin.stop();
  } finally {
    globalThis.fetch = realFetch;
  }

  const turn = h.turns[0]!;
  assert.deepEqual(fetched, ["https://cdn.discordapp.com/attachments/1/2/screen.png"]);
  assert.deepEqual(
    turn.attachments?.map((a) => [a.name, a.mimetype, a.sizeBytes]),
    [["screen.png", "image/png", 7]],
  );
  assert.equal(h.blobs.get(turn.attachments![0]!.blobId)?.toString(), "PNGDATA");
  assert.match(turn.inboundNotes?.join(" ") ?? "", /evil\.png/);
});

test("files QM returns are uploaded after its reply, and oversized ones are explained", async () => {
  const h = harness({
    result: () => ({
      status: "ok",
      reply: "here you go",
      attachments: [
        { name: "chart.png", mimetype: "image/png", sizeBytes: 5, blobId: "out-1" },
        { name: "huge.zip", mimetype: "application/zip", sizeBytes: 50 * 1024 * 1024, blobId: "out-2" },
      ],
    }),
  });
  h.blobs.set("out-1", Buffer.from("CHART"));
  const { api, handlers, plugin } = await boot(h);
  handlers.onMessage(dm(ALICE, "make me a chart"));
  await until(() => api.files.length === 1 && api.sent.length === 2, "files and note");
  await plugin.stop();

  assert.equal(api.sent[0]!.content, "here you go");
  assert.deepEqual(api.files[0]!.names, ["chart.png"]);
  assert.deepEqual(api.files[0]!.bytes, ["CHART"]);
  assert.match(api.sent[1]!.content, /huge\.zip.*too large/);
});

test("a file the agent posts to a thread is uploaded there", async () => {
  const h = harness({});
  h.blobs.set("out-3", Buffer.from("REPORT"));
  h.queue.push({
    id: "d-file",
    destination: { type: "discord", target: "thread-2" },
    text: "",
    attachments: [{ name: "report.pdf", mimetype: "application/pdf", sizeBytes: 6, blobId: "out-3" }],
    idempotencyKey: "post:file",
    createdAt: Date.now() - 60_000,
    deliveredAt: null,
  });
  const api = new FakeDiscord();
  const { plugin } = await boot(h, api);
  await until(() => h.deliveriesAcked.length === 1, "delivery acked");
  await plugin.stop();

  assert.deepEqual(api.files, [{ channelId: "thread-2", names: ["report.pdf"], bytes: ["REPORT"] }]);
  assert.equal(api.sent.length, 0);
});

test("the agent's reply-under, edit and delete reach the Discord messages it named", async () => {
  const h = harness({});
  const row = (id: string, destination: Delivery["destination"], text: string): Delivery => ({
    id,
    destination,
    text,
    idempotencyKey: `post:${id}`,
    createdAt: Date.now() - 60_000,
    deliveredAt: null,
  });
  h.queue.push(
    row("reply", { type: "discord", target: "thread-3:800000000000000031" }, "answering that one"),
    row("edit", { type: "discord", target: "thread-3", editRef: "800000000000000032" }, "fixed wording"),
    row("delete", { type: "discord", target: "thread-3", delete: { messageTs: "800000000000000033" } }, ""),
  );
  const api = new FakeDiscord();
  const { plugin } = await boot(h, api);
  await until(() => h.deliveriesAcked.length === 3, "deliveries acked");
  await plugin.stop();

  assert.deepEqual(
    api.sent.map((m) => [m.channelId, m.content, m.replyTo]),
    [["thread-3", "answering that one", "800000000000000031"]],
  );
  assert.deepEqual(
    api.edits.map((e) => [e.channelId, e.messageId, e.content]),
    [["thread-3", "800000000000000032", "fixed wording"]],
  );
  assert.deepEqual(api.removed, ["800000000000000033"]);
});

test("the agent can read its Discord thread: a pending request is answered from the thread's history", async () => {
  const h = harness({
    contextRequests: [
      {
        id: "ctx-1",
        source: "discord",
        createdAt: Date.now(),
        status: "pending",
        query: { conversationTarget: "thread-9", count: 10 },
      },
    ],
  });
  const api = new FakeDiscord();
  api.history.set("thread-9", [
    {
      ...dm(BOT, "the earlier answer", "900000000000000002"),
      channel_id: "thread-9",
      author: { id: BOT, username: "qm", global_name: null, bot: true },
    },
    { ...dm(ALICE, "what's the plan?", "900000000000000001"), channel_id: "thread-9" },
  ]);
  const { plugin } = await boot(h, api);
  await until(() => h.fulfilled.length === 1, "context answered");
  await plugin.stop();

  const result = h.fulfilled[0]!.result as { messages: Array<{ ts: string; author: string; text: string }> };
  assert.deepEqual(
    result.messages.map((m) => [m.ts, m.author, m.text]),
    [
      ["900000000000000001", "alice", "what's the plan?"],
      ["900000000000000002", "you", "the earlier answer"],
    ],
  );
});

test("the agent's react and pin actions land on the Discord message it named", async () => {
  const h = harness({});
  const row = (id: string, destination: Delivery["destination"]): Delivery => ({
    id,
    destination,
    text: "",
    idempotencyKey: `post:${id}`,
    createdAt: Date.now() - 60_000,
    deliveredAt: null,
  });
  h.queue.push(
    row("r1", {
      type: "discord",
      target: "thread-4",
      react: { messageTs: "800000000000000041", emoji: "white_check_mark" },
    }),
    row("r2", {
      type: "discord",
      target: "thread-4",
      react: { messageTs: "800000000000000041", emoji: "not_a_real_emoji" },
    }),
    row("p1", { type: "discord", target: "thread-4", pin: { messageTs: "800000000000000042" } }),
    row("p2", { type: "discord", target: "thread-4", pin: { messageTs: "800000000000000043", remove: true } }),
  );
  const api = new FakeDiscord();
  const { plugin } = await boot(h, api);
  await until(() => h.deliveriesAcked.length === 4, "deliveries acked");
  await plugin.stop();

  assert.deepEqual(api.reactions, [["thread-4", "800000000000000041", "✅"]]);
  assert.deepEqual(api.pins, [
    ["thread-4", "800000000000000042", false],
    ["thread-4", "800000000000000043", true],
  ]);
  assert.equal(api.sent.length, 0);
});

test("reactions and pins on the message that started a thread land in the parent channel", async () => {
  const h = harness({ result: () => ({ status: "ok", reply: "On it [[react: eyes]]" }) });
  const api = new FakeDiscord();
  api.channels.set(CHANNEL, { id: CHANNEL, type: 0, name: "general", guildId: GUILD });
  const row = (id: string, destination: Delivery["destination"]): Delivery => ({
    id,
    destination,
    text: "",
    idempotencyKey: `post:${id}`,
    createdAt: Date.now() - 60_000,
    deliveredAt: null,
  });
  const { handlers, plugin } = await boot(h, api);
  handlers.onMessage({
    ...dm(ALICE, `<@${BOT}> look`),
    id: "800000000000000061",
    channel_id: CHANNEL,
    guild_id: GUILD,
    mentions: [{ id: BOT } as never],
  });
  await until(() => api.reactions.length === 1, "trigger reaction");
  h.queue.push(
    row("r-start", {
      type: "discord",
      target: "800000000000000061",
      react: { messageTs: "800000000000000061", emoji: "tada" },
    }),
    row("p-start", { type: "discord", target: "800000000000000061", pin: { messageTs: "800000000000000061" } }),
  );
  await until(() => h.deliveriesAcked.length === 2, "deliveries acked");
  await plugin.stop();

  assert.deepEqual(api.reactions, [
    [CHANNEL, "800000000000000061", "👀"],
    [CHANNEL, "800000000000000061", "🎉"],
  ]);
  assert.deepEqual(api.pins, [[CHANNEL, "800000000000000061", false]]);
});

test("reactions and pins on a forum post's opening message stay in the post", async () => {
  const h = harness({ result: () => ({ status: "ok", reply: "On it [[react: eyes]]" }) });
  const api = new FakeDiscord();
  const FORUM = "600000000000000009";
  const POST = "800000000000000081";
  api.channels.set(FORUM, { id: FORUM, type: 15, name: "ideas", guildId: GUILD });
  api.channels.set(POST, { id: POST, type: 11, parentId: FORUM, guildId: GUILD });
  const { handlers, plugin } = await boot(h, api);
  handlers.onMessage({
    ...dm(ALICE, `<@${BOT}> thoughts?`),
    id: POST,
    channel_id: POST,
    guild_id: GUILD,
    mentions: [{ id: BOT } as never],
  });
  await until(() => api.reactions.length === 1, "trigger reaction");
  h.queue.push({
    id: "p-post",
    destination: { type: "discord", target: POST, pin: { messageTs: POST } },
    text: "",
    idempotencyKey: "post:p-post",
    createdAt: Date.now() - 60_000,
    deliveredAt: null,
  });
  await until(() => h.deliveriesAcked.length === 1, "pin acked");
  await plugin.stop();

  assert.deepEqual(api.reactions, [[POST, POST, "👀"]]);
  assert.deepEqual(api.pins, [[POST, POST, false]]);
});

test("a react the agent asks for that Discord can never accept is settled, not retried", async () => {
  const h = harness({});
  const api = new FakeDiscord();
  api.reactionErrors.set("🎉", 10014);
  h.queue.push({
    id: "r-bad",
    destination: { type: "discord", target: "thread-4", react: { messageTs: "800000000000000071", emoji: "tada" } },
    text: "",
    idempotencyKey: "post:r-bad",
    createdAt: Date.now() - 60_000,
    deliveredAt: null,
  });
  const { plugin } = await boot(h, api);
  await until(() => h.deliveriesAcked.length === 1, "settled");
  await plugin.stop();
  assert.deepEqual(api.reactions, []);
});

test("a streamed snapshot that is only a react directive posts nothing", async () => {
  const h = harness({ snapshots: ["[[react: eyes]]"], result: () => ({ status: "ok", reply: "Done." }) });
  const { api, handlers, plugin } = await boot(h);
  handlers.onMessage(dm(ALICE, "go"));
  await until(() => h.acked.length === 1, "ack");
  await plugin.stop();
  assert.deepEqual(
    api.sent.map((m) => m.content),
    ["Done."],
  );
});

test("QM reacts to the message instead of replying when the reply check says so, and honours react directives", async () => {
  let reply: TurnResult = { status: "react", reactions: ["pray"] };
  const h = harness({ result: () => reply });
  const { api, handlers, plugin } = await boot(h);
  handlers.onMessage(dm(ALICE, "thanks!", "900000000000000051"));
  await until(() => api.reactions.length === 1, "reaction");
  reply = { status: "ok", reply: "Done [[react: tada]]" };
  handlers.onMessage(dm(ALICE, "react with tada please", "900000000000000052"));
  await until(() => api.reactions.length === 2 && api.sent.length === 1, "directive reaction");
  await plugin.stop();

  assert.deepEqual(api.reactions, [
    [DM, "900000000000000051", "🙏"],
    [DM, "900000000000000052", "🎉"],
  ]);
  assert.equal(api.sent[0]!.content, "Done", "the directive never shows as text");
  assert.match(h.turns[1]!.gatewayContext?.instructions ?? "", /\[\[react:/);
});

test("a file sent to a person by DM is uploaded to their DM", async () => {
  const h = harness({});
  installPrincipalLinks({
    canonical: (key) => (key === `discord:${ALICE}` ? "alice@example.com" : undefined),
    aliases: (key) => (key === "alice@example.com" ? [`discord:${ALICE}`] : []),
  });
  h.blobs.set("out-4", Buffer.from("NOTES"));
  h.queue.push({
    id: "d-dm-file",
    destination: { type: "principal", target: "alice@example.com" },
    text: "",
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 5, blobId: "out-4" }],
    idempotencyKey: "dm:file",
    createdAt: Date.now() - 60_000,
    deliveredAt: null,
  });
  const api = new FakeDiscord();
  try {
    const { plugin } = await boot(h, api);
    await until(() => h.deliveriesAcked.length === 1, "delivery acked");
    await plugin.stop();
  } finally {
    installPrincipalLinks(null);
  }
  assert.deepEqual(api.files, [{ channelId: `dm-${ALICE}`, names: ["notes.txt"], bytes: ["NOTES"] }]);
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

async function fakeDiscordGatewayServer(readyDelayMs: number) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((r) => server.on("listening", r));
  const port = (server.address() as { port: number }).port;
  const state = { open: new Set<WebSocket>(), identifies: 0, port, server };
  server.on("connection", (socket) => {
    state.open.add(socket);
    socket.on("close", () => state.open.delete(socket));
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    socket.on("message", (raw) => {
      const payload = JSON.parse(String(raw)) as { op: number };
      if (payload.op === 1) socket.send(JSON.stringify({ op: 11 }));
      if (payload.op !== 2) return;
      state.identifies++;
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: {
              v: 10,
              session_id: `s${state.identifies}`,
              resume_gateway_url: `ws://127.0.0.1:${port}`,
              user: { id: BOT, username: "qm" },
              guilds: [],
              application: { id: "app", flags: 0 },
            },
          }),
        );
      }, readyDelayMs);
    });
  });
  const rest = {
    async get() {
      return {
        url: `ws://127.0.0.1:${port}`,
        shards: 1,
        session_start_limit: { remaining: 10, reset_after: 60_000, max_concurrency: 1, total: 1_000 },
      };
    },
  };
  const messages: DiscordMessage[] = [];
  const connection = createDiscordGateway("token", rest as never).open({
    onMessage: (m) => messages.push(m),
    onInteraction() {},
  });
  return { state, connection, messages, stop: () => new Promise((r) => server.close(r)) };
}

test("a gateway closed mid-handshake returns promptly and leaves no session open", async () => {
  const { state, connection, messages, stop } = await fakeDiscordGatewayServer(300);
  try {
    await until(() => state.identifies === 1, "first identify");
    const startedAt = Date.now();
    await connection.close();
    assert.ok(Date.now() - startedAt < 6_000);
    await until(() => state.open.size === 0, "every socket closed");
    await new Promise((r) => setTimeout(r, 1_000));
    assert.equal(state.open.size, 0);
    assert.deepEqual(messages, []);
  } finally {
    await stop();
  }
});

test("a gateway closed while a ready session reconnects leaves no session behind", async () => {
  const { state, connection, messages, stop } = await fakeDiscordGatewayServer(10);
  try {
    await connection.ready;
    for (const socket of state.open) socket.close(1000);
    await new Promise((r) => setTimeout(r, 50));
    await connection.close();
    await until(() => state.identifies === 2, "reconnect identify");
    await until(() => state.open.size === 0, "every socket closed");
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(state.open.size, 0);
    assert.deepEqual(messages, []);
  } finally {
    await stop();
  }
});

const REQUEST_ID = "a1b2c3d4e5f60718";

function click(customId: string, user: string, channelId: string, messageId: string): APIInteraction {
  return {
    id: `click-${customId}-${user}`,
    token: "tok",
    type: 3,
    data: { custom_id: customId, component_type: 2 },
    message: { id: messageId, channel_id: channelId },
    channel: { id: channelId },
    user: { id: user, username: user === ALICE ? "alice" : "mallory", global_name: null },
  } as unknown as APIInteraction;
}

function linkBoth(): void {
  const aliases: Record<string, string> = {
    [`discord:${ALICE}`]: "alice@example.com",
    [`discord:${MALLORY}`]: "mallory@example.com",
  };
  installPrincipalLinks({
    canonical: (key) => aliases[key],
    aliases: (key) => Object.keys(aliases).filter((alias) => aliases[alias] === key),
  });
}

function queued(id: string, destination: Delivery["destination"], text: string, key: string): Delivery {
  return { id, destination, text, idempotencyKey: key, createdAt: Date.now() - 60_000, deliveredAt: null };
}

test("a pending command approval reaches the requester as buttons and only their click resumes the conversation", async () => {
  linkBoth();
  const h = harness({
    linked: { [ALICE]: "alice@example.com", [MALLORY]: "mallory@example.com" },
    approvals: {
      [REQUEST_ID]: {
        requestId: REQUEST_ID,
        createdAt: 5,
        command: "rm -rf build",
        reason: "destructive",
        request: {
          surface: "discord",
          actor: { externalId: "alice@example.com" },
          conversation: { kind: "dm", threadRef: `discord:dm:${DM}`, audience: [] },
          deliveryTarget: DM,
          text: "clean the build",
          redeliveryKey: `discord:${DM}:m1`,
        },
      },
    },
    result: (body) =>
      body.approval
        ? { status: "ok", reply: "cleaned up" }
        : {
            status: "pending_approval",
            pendingApprovals: [{ requestId: REQUEST_ID, command: "rm -rf build", reason: "destructive" }],
          },
  });
  h.queue.push(
    queued(
      "approval-row",
      { type: "principal", target: "alice@example.com", commandApprovalId: REQUEST_ID },
      "Approval needed: rm -rf build",
      `command-approval:${REQUEST_ID}:5`,
    ),
  );
  const api = new FakeDiscord();
  try {
    const { handlers, plugin } = await boot(h, api);
    handlers.onMessage(dm(ALICE, "clean the build"));
    await until(() => h.turns.length === 1 && h.deliveriesAcked.length === 1, "approval card");
    const card = api.sent.find((m) => m.buttons?.length)!;
    assert.equal(card.channelId, `dm-${ALICE}`);
    assert.match(card.content, /Approval needed[\s\S]*rm -rf build[\s\S]*destructive/);
    assert.deepEqual(
      card.buttons!.map((b) => b.id),
      ["once", "session", "always", "deny"].map((scope) => `qm:cmd:${scope}:${REQUEST_ID}`),
    );
    assert.equal(
      api.sent.some((m) => m.channelId === DM),
      false,
    );

    handlers.onInteraction(click(`qm:cmd:once:${REQUEST_ID}`, MALLORY, card.channelId, card.id));
    await until(() => api.ephemeral.length === 1, "refusal note");
    assert.equal(api.ephemeral[0], "Only the person who asked can approve or deny this.");
    assert.equal(h.turns.length, 1);

    handlers.onInteraction(click(`qm:cmd:once:${REQUEST_ID}`, ALICE, card.channelId, card.id));
    await until(() => api.sent.some((m) => m.content === "cleaned up"), "resumed reply");
    await plugin.stop();
  } finally {
    installPrincipalLinks(null);
  }

  const resumed = h.turns[1]!;
  assert.deepEqual(resumed.approval, { requestId: REQUEST_ID, approved: true, scope: "once" });
  assert.equal(resumed.actor.externalId, `discord:${ALICE}`);
  assert.equal(resumed.redeliveryKey, undefined);
  assert.equal(resumed.text, "clean the build");
  assert.equal(api.sent.find((m) => m.content === "cleaned up")?.channelId, DM);
  const decided = api.edits.find((e) => /Allowed once/.test(e.content))!;
  assert.deepEqual(decided.buttons, []);
  assert.deepEqual(api.deferredUpdates.length, 2);
});

test("a pending approval in a server thread points the requester to their DM instead of the web app", async () => {
  const h = harness({
    result: () => ({
      status: "pending_approval",
      pendingApprovals: [{ requestId: REQUEST_ID, command: "deploy", reason: "publishes" }],
    }),
  });
  const api = new FakeDiscord();
  api.channels.set(CHANNEL, { id: CHANNEL, type: 0, name: "general", guildId: GUILD });
  const { handlers, plugin } = await boot(h, api);
  handlers.onMessage({
    ...dm(ALICE, `<@${BOT}> ship it`),
    id: "800000000000000009",
    channel_id: CHANNEL,
    guild_id: GUILD,
    mentions: [{ id: BOT } as never],
  });
  await until(() => api.sent.length === 1, "pending note");
  await plugin.stop();

  assert.deepEqual(
    api.sent.map((m) => [m.channelId, m.content]),
    [["800000000000000009", "I sent you a DM to approve before I continue."]],
  );
});

test("credential and app access requests arrive as buttons that record the owner's decision", async () => {
  linkBoth();
  const keychain = {
    ask: { id: "ask1", status: "pending", requestedMode: "once", requesterScopeId: `channel:${CHANNEL}` },
    service: "github",
    conversation: "#general",
  } as unknown as KeychainApprovalView;
  const access = { deploymentId: "00000000-0000-4000-8000-000000000001", requesterId: "bob@example.com" };
  const h = harness({ keychain, deployRequests: { "access-row": access } });
  h.queue.push(
    queued("ask-row", { type: "discord", target: "thread-9", keychainAskId: "ask1" }, "x", "ask:ask1:notice"),
    queued("ask-done", { type: "discord", target: "thread-9", keychainAskId: "ask1" }, "x", "ask:ask1:resolved"),
    queued(
      "access-row",
      { type: "principal", target: "alice@example.com", deploymentAccess: access },
      "bob@example.com asked to open your app.",
      "deploy-access:1",
    ),
  );
  const api = new FakeDiscord();
  try {
    const { handlers, plugin } = await boot(h, api);
    await until(() => h.deliveriesAcked.length === 3, "cards delivered");
    assert.equal(api.sent.length, 2);
    const askCard = api.sent.find((m) => m.channelId === "thread-9")!;
    assert.match(askCard.content, /Use your \*\*github\*\* credential in #general \(one-time access\)/);
    assert.deepEqual(
      askCard.buttons!.map((b) => [b.id, b.label]),
      [
        ["qm:key:once:ask1", "Allow once"],
        ["qm:key:standing:ask1", "Allow"],
        ["qm:key:deny:ask1", "Deny"],
      ],
    );
    const accessCard = api.sent.find((m) => m.channelId === `dm-${ALICE}`)!;
    assert.deepEqual(
      accessCard.buttons!.map((b) => b.id),
      ["qm:app:approve:access-row", "qm:app:decline:access-row"],
    );

    handlers.onInteraction(click("qm:key:once:ask1", ALICE, askCard.channelId, askCard.id));
    handlers.onInteraction(click("qm:app:approve:access-row", ALICE, accessCard.channelId, accessCard.id));
    await until(() => api.edits.length === 2, "cards updated");
    await plugin.stop();
  } finally {
    installPrincipalLinks(null);
  }

  assert.deepEqual(h.decisions, [
    ["keychain", "ask1", `discord:${ALICE}`, "once"],
    ["deploy", access, `discord:${ALICE}`, true],
  ]);
  const askEdit = api.edits.find((e) => e.channelId === "thread-9")!;
  assert.match(askEdit.content, /Approved — one-time access/);
  assert.deepEqual(askEdit.buttons, []);
  assert.deepEqual(
    api.edits.find((e) => e.channelId === `dm-${ALICE}`),
    {
      channelId: `dm-${ALICE}`,
      messageId: api.sent.find((m) => m.channelId === `dm-${ALICE}`)!.id,
      content: "Approved. bob can now open the app.",
      buttons: [],
    },
  );
});

function storedApproval(threadRef: string): StoredApprovalView {
  return {
    requestId: REQUEST_ID,
    createdAt: 5,
    command: "rm -rf build",
    reason: "destructive",
    request: {
      surface: "discord",
      actor: { externalId: "alice@example.com" },
      conversation: { kind: "dm", threadRef, audience: [] },
      deliveryTarget: DM,
      text: "clean the build",
    },
  };
}

async function clickApproval(
  h: Harness,
  clicks: string[],
  settled: (api: FakeDiscord) => boolean,
): Promise<FakeDiscord> {
  const api = new FakeDiscord();
  linkBoth();
  try {
    const { handlers, plugin } = await boot(h, api);
    for (const id of clicks) handlers.onInteraction(click(id, ALICE, `dm-${ALICE}`, "card-1"));
    await until(() => settled(api), "approval settled");
    await plugin.stop();
  } finally {
    installPrincipalLinks(null);
  }
  return api;
}

test("an approval that core leaves pending puts the buttons back instead of claiming it ran", async () => {
  const h = harness({
    approvals: { [REQUEST_ID]: storedApproval(`discord:dm:${DM}`) },
    result: () => ({
      status: "pending_approval",
      reason: "Another approval in this conversation comes first.",
      pendingApprovals: [{ requestId: REQUEST_ID, command: "rm -rf build", reason: "destructive" }],
    }),
  });
  const api = await clickApproval(h, [`qm:cmd:once:${REQUEST_ID}`], (a) => a.edits.length === 2);

  assert.equal(h.turns.length, 1);
  const [decided, restored] = api.edits;
  assert.deepEqual(decided?.buttons, []);
  assert.match(restored!.content, /Another approval in this conversation comes first\. The approval is still pending/);
  assert.equal(restored!.buttons?.length, 4);
});

test("a delegated approval resumes the subagent without posting its output into the conversation", async () => {
  const h = harness({
    approvals: { [REQUEST_ID]: storedApproval("agent:main:subagent:child-1") },
    result: () => ({ status: "ok", reply: "raw subagent output" }),
  });
  const api = await clickApproval(h, [`qm:cmd:once:${REQUEST_ID}`], (a) => a.edits.length === 2);

  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0]!.conversation.threadRef, "agent:main:subagent:child-1");
  assert.equal(
    api.sent.some((m) => m.content.includes("raw subagent output")),
    false,
  );
  assert.match(api.edits[1]!.content, /Results will return to the original conversation/);
});

test("Allow and Deny clicked together decide once; the second click is told it was already decided", async () => {
  const h = harness({
    approvals: { [REQUEST_ID]: storedApproval(`discord:dm:${DM}`) },
    consumeApprovals: true,
    result: () => ({ status: "ok", reply: "cleaned up" }),
  });
  const api = await clickApproval(
    h,
    [`qm:cmd:once:${REQUEST_ID}`, `qm:cmd:deny:${REQUEST_ID}`],
    (a) => a.ephemeral.length === 1,
  );

  assert.equal(h.turns.length, 1);
  assert.deepEqual(h.turns[0]!.approval, { requestId: REQUEST_ID, approved: true, scope: "once" });
  assert.deepEqual(api.ephemeral, ["That approval was already decided or has expired."]);
});

function modelCommand(user: string, channelId: string, name?: string, autocomplete = false): APIInteraction {
  return {
    id: `model-${name ?? "show"}-${autocomplete}`,
    token: "tok",
    type: autocomplete ? 4 : 2,
    data: {
      name: "qm",
      options: [
        {
          name: "model",
          type: 1,
          ...(name !== undefined ? { options: [{ name: "name", type: 3, value: name, focused: autocomplete }] } : {}),
        },
      ],
    },
    channel: { id: channelId },
    user: { id: user },
  } as unknown as APIInteraction;
}

async function subscribedApp(provider: "openai" | "anthropic") {
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi", "claude"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setOAuth("alice@example.com", provider, {
    accessToken: "synthetic-access",
    refreshToken: "synthetic-refresh",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setPersonalModelAuth("alice@example.com", true, provider);
  const runtime: RuntimeDeps = {
    config: built.config,
    userModelCredentials: built.userModelCredentials,
    harnessId: "pi",
    providerKeys: { anthropic: false, openai: false, openrouter: false },
  };
  return { built, runtime };
}

test("/qm model in a DM sets only this conversation's session, from the user's ChatGPT subscription models", async () => {
  const { built, runtime } = await subscribedApp("openai");
  const threadRef = `discord:dm:${DM}`;
  const session = await built.sessions.getOrCreateByThread(
    threadRef,
    "dm",
    "personal:alice@example.com" as never,
    undefined,
    "discord",
  );
  await built.sessions.addParticipant(session.id, "alice@example.com");
  const h = harness({ runtime, sessions: built.sessions });
  const api = new FakeDiscord();
  api.channels.set(DM, { id: DM, type: 1 });
  api.channels.set("500000000000000009", { id: "500000000000000009", type: 1 });
  const { handlers, plugin } = await boot(h, api);
  const answer = async (name?: string, channelId = DM) => {
    const before = api.ephemeral.length;
    handlers.onInteraction(modelCommand(ALICE, channelId, name));
    await until(() => api.ephemeral.length > before, `/qm model ${name ?? ""}`);
    return api.ephemeral.at(-1)!;
  };
  try {
    handlers.onInteraction(modelCommand(ALICE, DM, "sol", true));
    await until(() => api.suggestions.length === 1, "suggestions");
    assert.ok(api.suggestions[0]!.some((c) => c.value === "pi:codex/gpt-5.6-sol"));
    assert.ok(api.suggestions[0]!.every((c) => c.value === "default" || c.value.startsWith("pi:codex/")));

    assert.match(await answer(), /^⚙️ \*\*Model for this conversation\*\*\nCurrent: \*\*.+\*\* · .+ \(default\)/);
    await built.sessions.setRuntime(session.id, {
      harnessId: "pi",
      modelId: "codex/gpt-5.5",
      effortLevel: "max",
      fastMode: false,
    });
    assert.match(await answer("pi:codex/gpt-5.6-sol"), /^Done\. This conversation now uses \*\*/);
    const saved = (await built.sessions.getByThread(threadRef))?.runtime;
    assert.equal(saved?.modelId, "codex/gpt-5.6-sol");
    assert.equal(saved?.effortLevel, "max");
    assert.equal(await built.config.getRuntimeSelectionDurable("personal:alice@example.com" as never), null);
    assert.match(await answer("claude-sonnet-5"), /I don't have a model called "claude-sonnet-5" for you here/);
    assert.match(await answer("default"), /uses the default model again/);
    assert.equal((await built.sessions.getByThread(threadRef))?.runtime, undefined);
    assert.equal(
      await answer("pi:codex/gpt-5.6-sol", "500000000000000009"),
      "Send me a message here first, then run `/qm model`.",
    );
  } finally {
    await plugin.stop();
  }
});

test("/qm model in a server thread sets that thread's session, including Claude subscription models", async () => {
  const { built, runtime } = await subscribedApp("anthropic");
  const threadRef = `discord:ch:${CHANNEL}:thread-7`;
  const session = await built.sessions.getOrCreateByThread(
    threadRef,
    "channel",
    `channel:${CHANNEL}` as never,
    "general",
    "discord",
  );
  await built.sessions.addParticipant(session.id, "alice@example.com");
  const h = harness({ runtime, sessions: built.sessions });
  const api = new FakeDiscord();
  api.channels.set(CHANNEL, { id: CHANNEL, type: 0, name: "general", guildId: GUILD });
  api.channels.set("thread-7", { id: "thread-7", type: 11, parentId: CHANNEL, guildId: GUILD });
  const { handlers, plugin } = await boot(h, api);
  try {
    handlers.onInteraction({
      ...(modelCommand(ALICE, "thread-7", "claude:claude-sonnet-5") as object),
      guild_id: GUILD,
    } as APIInteraction);
    handlers.onInteraction({
      ...(modelCommand(ALICE, CHANNEL, "claude:claude-sonnet-5") as object),
      id: "model-in-channel",
      guild_id: GUILD,
    } as APIInteraction);
    await until(() => api.ephemeral.length === 2, "model replies");
  } finally {
    await plugin.stop();
  }
  assert.ok(api.ephemeral.some((m) => /^Done\. This conversation now uses \*\*/.test(m)));
  assert.ok(api.ephemeral.includes("Run `/qm model` in my DM or in a thread I'm working in."));
  assert.equal((await built.sessions.getByThread(threadRef))?.runtime?.modelId, "claude-sonnet-5");
  assert.equal(await built.config.getRuntimeSelectionDurable(`channel:${CHANNEL}` as never), null);
});

test("an approval core accepted but whose wait then fails stays decided instead of offering a second run", async () => {
  const h = harness({
    approvals: { [REQUEST_ID]: storedApproval(`discord:dm:${DM}`) },
    result: () => {
      throw new Error("connection reset while waiting");
    },
  });
  const api = await clickApproval(h, [`qm:cmd:once:${REQUEST_ID}`], (a) => a.edits.length >= 1 && h.turns.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(api.edits.length, 1);
  assert.match(api.edits[0]!.content, /^Allowed once/);
  assert.deepEqual(api.edits[0]!.buttons, []);
  assert.equal(
    api.sent.some((m) => m.content.startsWith("⚠️")),
    false,
  );
});

test("a refused approval replay is reported once, on the card, not again in the conversation", async () => {
  const h = harness({
    approvals: { [REQUEST_ID]: storedApproval(`discord:dm:${DM}`) },
    result: () => ({ status: "refused", reason: "the command is blocked by policy" }),
  });
  const api = await clickApproval(h, [`qm:cmd:once:${REQUEST_ID}`], (a) => a.edits.length === 2);

  assert.match(api.edits[1]!.content, /I couldn't continue/);
  assert.equal(
    api.sent.some((m) => m.content.includes("⚠️")),
    false,
  );
});

test("/qm model with no name walks provider and model dropdowns and saves the pick on this conversation", async () => {
  const { built, runtime } = await subscribedApp("openai");
  const threadRef = `discord:dm:${DM}`;
  const session = await built.sessions.getOrCreateByThread(
    threadRef,
    "dm",
    "personal:alice@example.com" as never,
    undefined,
    "discord",
  );
  await built.sessions.addParticipant(session.id, "alice@example.com");
  const h = harness({ runtime, sessions: built.sessions });
  const api = new FakeDiscord();
  api.channels.set(DM, { id: DM, type: 1 });
  const { handlers, plugin } = await boot(h, api);
  const pickerClick = async (customId: string, values?: string[]) => {
    const before = api.replies.length;
    handlers.onInteraction({
      id: `pick-${customId}-${values?.join() ?? ""}`,
      token: "tok",
      type: 3,
      data: { custom_id: customId, component_type: values ? 3 : 2, ...(values ? { values } : {}) },
      message: { id: "picker", channel_id: DM },
      channel: { id: DM },
      user: { id: ALICE, username: "alice", global_name: null },
    } as unknown as APIInteraction);
    await until(() => api.replies.length > before, customId);
    return api.replies.at(-1)!;
  };
  try {
    handlers.onInteraction(modelCommand(ALICE, DM));
    await until(() => api.replies.length === 1, "picker");
    const providers = api.replies[0]!;
    assert.match(providers.content, /Model for this conversation[\s\S]*\(default\)[\s\S]*Choose a provider/);
    assert.equal(providers.select?.id, "qm:model:group");
    const codex = providers.select!.options.find((o) => o.value === "codex");
    assert.match(codex!.label, /^Codex \(ChatGPT subscription\) \(\d+ models?\)$/);
    assert.equal(codex!.description, "current");
    assert.deepEqual(
      providers.buttons?.map((b) => b.id),
      ["qm:model:cancel"],
    );

    const models = await pickerClick("qm:model:group", ["codex"]);
    assert.equal(models.select?.id, "qm:model:pick");
    assert.ok(models.select!.options.every((o) => o.value.startsWith("pi:codex/")));
    assert.equal(models.select!.options.filter((o) => o.selected).length, 1);
    assert.deepEqual(
      models.buttons?.map((b) => b.id),
      ["qm:model:back", "qm:model:cancel"],
    );

    const done = await pickerClick("qm:model:pick", ["pi:codex/gpt-5.6-sol"]);
    assert.match(done.content, /^Done\. This conversation now uses \*\*/);
    assert.deepEqual(done.buttons, []);
    assert.equal((await built.sessions.getByThread(threadRef))?.runtime?.modelId, "codex/gpt-5.6-sol");

    handlers.onInteraction({ ...(modelCommand(ALICE, DM) as object), id: "picker-again" } as APIInteraction);
    await until(() => api.replies.length === 4, "picker again");
    assert.deepEqual(
      api.replies.at(-1)!.buttons?.map((b) => b.id),
      ["qm:model:default", "qm:model:cancel"],
    );
    assert.match((await pickerClick("qm:model:default")).content, /uses the default model again/);
    assert.equal((await built.sessions.getByThread(threadRef))?.runtime, undefined);
    assert.equal((await pickerClick("qm:model:cancel")).content, "No change.");
  } finally {
    await plugin.stop();
  }
});

test("Discord components put a select in its own row above the buttons, and an empty list clears them", () => {
  assert.deepEqual(components(undefined), {});
  assert.deepEqual(components([]), { components: [] });
  assert.deepEqual(
    components([{ id: "qm:model:cancel", label: "Cancel", style: "danger" }], {
      id: "qm:model:pick",
      placeholder: "Choose…",
      options: [
        { label: "Sol", value: "pi:codex/gpt-5.6-sol", selected: true },
        { label: "Terra", value: "pi:codex/gpt-6.1-terra", description: "current" },
      ],
    }),
    {
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: "qm:model:pick",
              placeholder: "Choose…",
              options: [
                { label: "Sol", value: "pi:codex/gpt-5.6-sol", default: true },
                { label: "Terra", value: "pi:codex/gpt-6.1-terra", description: "current" },
              ],
            },
          ],
        },
        { type: 1, components: [{ type: 2, custom_id: "qm:model:cancel", label: "Cancel", style: 4 }] },
      ],
    },
  );
});

test("/qm model with no models available answers in words instead of sending an empty dropdown", async () => {
  const h = harness({});
  h.core = {
    ...h.core,
    modelMenu: async () => ({
      session: { id: "s1" } as never,
      menu: { approvedHarnesses: ["pi"], modelsByHarness: { pi: [] }, modelCatalog: {} } as never,
      current: { harnessId: "pi", modelId: "none" },
    }),
  };
  const api = new FakeDiscord();
  api.channels.set(DM, { id: DM, type: 1 });
  const { handlers, plugin } = await boot(h, api);
  handlers.onInteraction(modelCommand(ALICE, DM));
  await until(() => api.replies.length === 1, "reply");
  await plugin.stop();
  assert.equal(api.replies[0]!.content, "You don't have any models to choose from here.");
  assert.equal(api.replies[0]!.select, undefined);
});
