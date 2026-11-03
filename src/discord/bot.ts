import { userFacingFailureClause } from "../core/failure-copy.ts";
import { renderConversationView, type RecentMessage } from "../surfaces/conversation.ts";
import { safeChunks, safeClip } from "../surfaces/safe-cut.ts";
import { turnFailureText, type CoreTurnBody, type TurnFlow } from "../surfaces/turn-flow.ts";
import type { ActorAssertion, TurnResult } from "../types.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import type { DiscordApi, DiscordChannel, DiscordMessage } from "./api.ts";
import type { DiscordCoreClient } from "./core.ts";

export const DISCORD_MESSAGE_LIMIT = 2_000;
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
const TYPING_REFRESH_MS = 8_000;
const CONTEXT_MESSAGES = 20;
const THREAD_NAME_LIMIT = 90;
const THREAD_ALREADY_EXISTS = 160004;
const DELIVERED_STATUSES = new Set<TurnResult["status"]>(["ok", "refused", "failed"]);

export interface AcceptGate {
  persisted(): void;
  failed(reason?: string): void;
}

interface Place {
  kind: "dm" | "channel";
  channelId: string;
  threadRef: string;
  channelRef?: string;
  channelName?: string;
  youOpenedIt?: boolean;
}

export function discordDmThreadRef(dmChannelId: string): string {
  return `discord:dm:${dmChannelId}`;
}

export function discordChannelThreadRef(parentChannelId: string, threadId: string): string {
  return `discord:ch:${parentChannelId}:${threadId}`;
}

export function threadRefForChannel(channel: DiscordChannel): string | undefined {
  if (!channel.guildId) return discordDmThreadRef(channel.id);
  if (THREAD_CHANNEL_TYPES.has(channel.type) && channel.parentId)
    return discordChannelThreadRef(channel.parentId, channel.id);
  return undefined;
}

function discordErrorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
}

function epochTs(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? (ms / 1000).toFixed(6) : "";
}

function displayName(author: DiscordMessage["author"]): string {
  return author.global_name || author.username;
}

export function createDiscordBot(deps: {
  api: DiscordApi;
  core: DiscordCoreClient;
  flow: TurnFlow;
  guildIds: ReadonlySet<string>;
  self: { id: string; username: string };
}) {
  const { api, core, flow, self } = deps;
  const selfMention = `<@${self.id}>`;

  function mentionsSelf(m: DiscordMessage): boolean {
    return m.mentions.some((u) => u.id === self.id) || m.content.includes(selfMention);
  }

  async function relevantPlace(
    m: DiscordMessage,
  ): Promise<{ channel?: DiscordChannel; addressed: boolean } | undefined> {
    if (m.author.bot || m.webhook_id || m.author.id === self.id) return undefined;
    if (!m.guild_id) return { addressed: true };
    if (!deps.guildIds.has(m.guild_id)) return undefined;
    const channel = await api.channel(m.channel_id);
    if (mentionsSelf(m)) return { channel, addressed: true };
    if (THREAD_CHANNEL_TYPES.has(channel.type) && channel.ownerId === self.id) return { channel, addressed: false };
    return undefined;
  }

  async function promptLink(userId: string): Promise<void> {
    if (!(await core.allowLinkPrompt(userId))) return;
    const url = await core.linkUrl(userId);
    const text = url
      ? `To talk with me, link your Discord account to your QM account first: ${url}`
      : "To talk with me, ask your QM admin to finish setting up Discord account linking.";
    await api.send(await api.openDm(userId), text);
  }

  async function resolvePlace(m: DiscordMessage, channel: DiscordChannel | undefined, text: string): Promise<Place> {
    if (!channel) return { kind: "dm", channelId: m.channel_id, threadRef: discordDmThreadRef(m.channel_id) };
    if (THREAD_CHANNEL_TYPES.has(channel.type) && channel.parentId) {
      return {
        kind: "channel",
        channelId: channel.id,
        threadRef: discordChannelThreadRef(channel.parentId, channel.id),
        channelRef: `discord:${channel.parentId}`,
        ...(channel.name ? { channelName: channel.name } : {}),
        youOpenedIt: channel.ownerId === self.id,
      };
    }
    let threadId: string;
    try {
      threadId = await api.startThread(channel.id, m.id, safeClip(text || "QM", THREAD_NAME_LIMIT));
    } catch (error) {
      if (discordErrorCode(error) !== THREAD_ALREADY_EXISTS) throw error;
      threadId = m.id;
    }
    return {
      kind: "channel",
      channelId: threadId,
      threadRef: discordChannelThreadRef(channel.id, threadId),
      channelRef: `discord:${channel.id}`,
      ...(channel.name ? { channelName: channel.name } : {}),
      youOpenedIt: true,
    };
  }

  async function threadContext(place: Place, trigger: DiscordMessage): Promise<Partial<CoreTurnBody>> {
    const raw = await api
      .recentMessages(place.channelId, CONTEXT_MESSAGES)
      .catch(swallowAs("discord: thread history", [] as DiscordMessage[]));
    const nameById = new Map<string, string>([[self.id, self.username]]);
    for (const m of raw) nameById.set(m.author.id, displayName(m.author));
    const messages: RecentMessage[] = raw
      .filter((m) => m.id !== trigger.id && (m.content.trim() || m.author.id === self.id))
      .map((m) => ({
        ts: epochTs(m.timestamp),
        name: displayName(m.author),
        authorId: m.author.id,
        text: m.content,
        ...(m.author.bot ? { isBot: true } : {}),
        ...(m.author.id === self.id ? { isSelf: true } : {}),
      }))
      .filter((m) => m.ts);
    const rendered = renderConversationView({
      channel: { kind: "channel", ...(place.channelName ? { name: place.channelName } : {}) },
      members: [],
      messages,
      here: { kind: "thread", youOpenedIt: place.youOpenedIt === true },
      files: [],
      omittedFiles: [],
      nameById,
    });
    return {
      ...(rendered.header ? { conversationHeader: rendered.header } : {}),
      ...(rendered.priorTurns.length ? { priorTurns: rendered.priorTurns } : {}),
      ...(rendered.detectContext ? { detectContext: rendered.detectContext } : {}),
    };
  }

  function createReplyWriter(channelId: string) {
    let placeholder: string | undefined;
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (step: () => Promise<void>): Promise<void> => {
      chain = chain.then(step);
      return chain;
    };
    return {
      stream(text: string, onPlaceholder: (messageId: string) => Promise<void>): void {
        const shown = safeClip(text, DISCORD_MESSAGE_LIMIT - 1);
        void enqueue(async () => {
          if (placeholder) return api.edit(channelId, placeholder, shown);
          placeholder = await api.send(channelId, shown);
          await onPlaceholder(placeholder);
        }).catch(swallowAs("discord: stream reply", undefined));
      },
      async finish(text: string): Promise<void> {
        await chain.catch(() => {});
        const parts = safeChunks(text, DISCORD_MESSAGE_LIMIT);
        await enqueue(async () => {
          for (const [i, part] of parts.entries()) {
            if (i === 0 && placeholder) await api.edit(channelId, placeholder, part);
            else await api.send(channelId, part);
          }
        });
      },
    };
  }

  function replyText(result: TurnResult, addressed: boolean): string {
    if (result.status === "ok") return result.reply?.trim() || (result.stopped ? "Stopped." : "");
    if (result.status === "refused" || result.status === "failed")
      return addressed ? `⚠️ ${userFacingFailureClause(result)}` : "";
    if (result.status === "pending_approval" && addressed)
      return result.reason ?? "This conversation is waiting on an approval in the QM web app.";
    return "";
  }

  async function handleMessage(m: DiscordMessage, stage?: () => Promise<AcceptGate>): Promise<void> {
    const relevant = await relevantPlace(m);
    if (!relevant) return;
    const gate = await stage?.();
    if (!core.linkedPrincipal(m.author.id)) {
      await promptLink(m.author.id);
      return gate?.persisted();
    }
    const text = m.content.replaceAll(selfMention, `@${self.username}`).trim();
    if (!text) return gate?.persisted();
    const place = await resolvePlace(m, relevant.channel, text);
    const actor: ActorAssertion = { externalId: `discord:${m.author.id}`, displayName: displayName(m.author) };
    const writer = createReplyWriter(place.channelId);
    let queuedRunId: string | undefined;
    let accepted = false;
    const accept = (): void => {
      accepted = true;
      gate?.persisted();
    };
    const typing = setInterval(() => void api.typing(place.channelId).catch(() => {}), TYPING_REFRESH_MS);
    void api.typing(place.channelId).catch(() => {});
    try {
      const body: CoreTurnBody = {
        actor,
        conversation: {
          kind: place.kind,
          threadRef: place.threadRef,
          ...(place.channelRef ? { channelRef: place.channelRef } : {}),
          ...(place.channelName ? { channelName: place.channelName } : {}),
          audience: [actor],
        },
        deliveryTarget: place.channelId,
        text,
        origin: relevant.addressed ? { kind: "human" } : { kind: "ambient", live: true },
        gatewayContext: {
          location: place.kind === "dm" ? "a Discord direct message with the user" : "a Discord thread",
          details: { channel: place.channelId },
          botHandle: self.username,
        },
        redeliveryKey: `discord:${m.channel_id}:${m.id}`,
        ...(place.kind === "channel" ? await threadContext(place, m) : {}),
      };
      let result: TurnResult;
      try {
        result = await flow.callCore(body, {
          deferDeliveryAck: true,
          onQueued: (runId) => {
            queuedRunId = runId;
            accept();
          },
          onSteered: accept,
          onSnapshot: (snapshot) =>
            writer.stream(snapshot, async (messageId) => {
              if (queuedRunId) await core.reportRunEditRef(queuedRunId, messageId);
            }),
        });
      } catch (error) {
        if (!accepted) gate?.failed(errMessage(error));
        console.error(`[discord] turn errored ch=${m.channel_id} msg=${m.id}: ${errMessage(error)}`);
        if (relevant.addressed) await writer.finish(`⚠️ ${turnFailureText(error)}`);
        return;
      }
      if (!accepted) accept();
      if (result.steered) return;
      const reply = replyText(result, relevant.addressed);
      const runId = queuedRunId;
      try {
        if (reply) await writer.finish(reply);
      } catch (error) {
        if (runId) flow.inFlightRuns.delete(runId);
        console.error(
          `[discord] reply post failed for run ${runId ?? "?"}; leaving it for the delivery poller:`,
          errMessage(error),
        );
        return;
      }
      if (runId && DELIVERED_STATUSES.has(result.status)) flow.ackRunDelivery(runId);
    } finally {
      clearInterval(typing);
    }
  }

  return { handleMessage };
}

export type DiscordBot = ReturnType<typeof createDiscordBot>;
