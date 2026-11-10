import { MessageFlags } from "@discordjs/core";
import { userFacingFailureClause } from "../core/failure-copy.ts";
import { isSubagentThreadRef } from "../sessions/session-syscalls.ts";
import { renderConversationView, type RecentMessage } from "../surfaces/conversation.ts";
import { safeClip } from "../surfaces/safe-cut.ts";
import { hasRunDelivery, turnFailureText, type CoreTurnBody, type TurnFlow } from "../surfaces/turn-flow.ts";
import type { ActorAssertion, TurnResult } from "../types.ts";
import { errMessage, reportFailure, swallowAs } from "../util/errors.ts";
import {
  DISCORD_MESSAGE_LIMIT,
  discordDisplayName,
  discordErrorCode,
  isConversationMessage,
  messageAttachments,
  messageHomeChannel,
  messageText,
  postMessage,
  type DiscordApi,
  type DiscordChannel,
  type DiscordMessage,
} from "./api.ts";
import type { DiscordCoreClient } from "./core.ts";
import type { ToolCallView } from "../surfaces/surface-core-client.ts";
import { downloadDiscordFile, receiveDiscordFiles, sendDiscordFiles } from "./files.ts";
import { emojiCharFor } from "../slack/emoji-map.ts";
import type { ThreadTracker } from "../slack/message-gating.ts";
import { alignMarkdownTables } from "../slack/mrkdwn.ts";
import { extractReactions, stripReactionDirectives } from "../slack/reactions.ts";

const MAX_REACTIONS = 5;

interface VoiceNote {
  transcript?: string;
  note?: string;
  downloaded?: { url: string; bytes: Uint8Array };
}

export const DISCORD_REACTION_INSTRUCTION =
  "When the user explicitly asks you to add an emoji reaction, actually react by writing the directive " +
  "`[[react: name1 name2]]` in your reply, using emoji short-names with NO colons (e.g. `[[react: eyes white_check_mark]]`, " +
  "`[[react: +1]]`, `[[react: tada]]`). Typing an emoji into your prose does nothing; only the directive adds a real " +
  "Discord reaction. The directive is stripped from what the user sees and the reactions (up to 5) go on the message " +
  "you're answering, so a reply can be just the directive. To react to a different message, use your surface tool's " +
  "react action with that message's id.";

function triggerMessageId(body: CoreTurnBody): string | undefined {
  const origin = body.origin;
  if (origin?.kind === "human") return origin.messageTs;
  if (origin?.kind === "ambient") return origin.entryTs;
  return undefined;
}

const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
const TYPING_REFRESH_MS = 8_000;
const CONTEXT_MESSAGES = 20;
const THREAD_NAME_LIMIT = 90;
const THREAD_ALREADY_EXISTS = 160004;
const CHANNEL_CACHE_LIMIT = 5_000;
const TOOL_ACTIVITY_LINES = 3;
const TOOL_ARGS_LIMIT = 300;
const STAKE_SCAN_MESSAGES = 100;

function toolCallLine(call: ToolCallView): string {
  const args = safeClip(JSON.stringify(call.args), TOOL_ARGS_LIMIT);
  return `🔧 \`${`${call.tool} ${args}`.replaceAll("`", "ˋ")}\``;
}

export interface TurnOutcome {
  result?: TurnResult;
  accepted: boolean;
}

export interface AcceptGate {
  persisted(): void;
  failed(reason?: string): void;
}

interface Place {
  kind: "dm" | "channel";
  channelId: string;
  openedFrom?: string;
  threadRef: string;
  channelRef?: string;
  channelName?: string;
  youOpenedIt?: boolean;
}

export function discordDmThreadRef(dmChannelId: string): string {
  return `discord:dm:${dmChannelId}`;
}

function discordChannelThreadRef(parentChannelId: string, threadId: string): string {
  return `discord:ch:${parentChannelId}:${threadId}`;
}

export function discordMessageKey(channelId: string, messageId: string): string {
  return `discord:${channelId}:${messageId}`;
}

export function threadRefForChannel(channel: DiscordChannel): string | undefined {
  if (!channel.guildId) return discordDmThreadRef(channel.id);
  if (THREAD_CHANNEL_TYPES.has(channel.type) && channel.parentId)
    return discordChannelThreadRef(channel.parentId, channel.id);
  return undefined;
}

export function createDiscordBot(deps: {
  api: DiscordApi;
  core: DiscordCoreClient;
  flow: TurnFlow;
  guildIds: ReadonlySet<string>;
  self: { id: string; username: string };
  threads: ThreadTracker;
}) {
  const { api, core, flow, self, threads } = deps;
  const selfMention = `<@${self.id}>`;
  const channels = new Map<string, DiscordChannel>();
  const stakeScans = new Map<string, Promise<boolean>>();

  function hasStakeIn(thread: DiscordChannel): Promise<boolean> {
    if (thread.ownerId === self.id) return Promise.resolve(true);
    const known = threads.get(thread.id, "");
    if (known !== undefined) return Promise.resolve(known);
    const inFlight = stakeScans.get(thread.id);
    if (inFlight) return inFlight;
    const scan = api
      .recentMessages(thread.id, STAKE_SCAN_MESSAGES)
      .then((history) => history.some((m) => m.author.id === self.id || mentionsSelf(m)))
      .catch(swallowAs("discord: thread stake", false))
      .then((found) => {
        threads.mark(thread.id, "", found);
        return threads.get(thread.id, "") === true;
      })
      .finally(() => stakeScans.delete(thread.id));
    stakeScans.set(thread.id, scan);
    return scan;
  }

  async function channelOf(channelId: string): Promise<DiscordChannel> {
    const cached = channels.get(channelId);
    if (cached) return cached;
    const channel = await api.channel(channelId);
    if (channels.size >= CHANNEL_CACHE_LIMIT) channels.clear();
    channels.set(channelId, channel);
    return channel;
  }

  function mentionsSelf(m: DiscordMessage): boolean {
    return m.mentions.some((u) => u.id === self.id) || m.content.includes(selfMention);
  }

  async function relevantPlace(
    m: DiscordMessage,
  ): Promise<{ channel?: DiscordChannel; addressed: boolean } | undefined> {
    if (!isConversationMessage(m)) return undefined;
    if (m.author.bot || m.webhook_id || m.author.id === self.id) return undefined;
    if (!m.guild_id) return { addressed: true };
    if (!deps.guildIds.has(m.guild_id)) return undefined;
    const addressed = mentionsSelf(m);
    const channel = await channelOf(m.channel_id);
    const isThread = THREAD_CHANNEL_TYPES.has(channel.type);
    if (addressed) {
      if (isThread) threads.mark(channel.id, "", true);
      return { channel, addressed };
    }
    if (isThread && (await hasStakeIn(channel))) return { channel, addressed };
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

  async function parentName(parentId: string): Promise<string | undefined> {
    return (await channelOf(parentId).catch(swallowAs("discord: parent channel", undefined)))?.name;
  }

  async function resolvePlace(m: DiscordMessage, channel: DiscordChannel | undefined, text: string): Promise<Place> {
    if (!channel) return { kind: "dm", channelId: m.channel_id, threadRef: discordDmThreadRef(m.channel_id) };
    if (THREAD_CHANNEL_TYPES.has(channel.type) && channel.parentId) {
      const name = await parentName(channel.parentId);
      return {
        kind: "channel",
        channelId: channel.id,
        threadRef: discordChannelThreadRef(channel.parentId, channel.id),
        channelRef: channel.parentId,
        ...(name ? { channelName: name } : {}),
        youOpenedIt: channel.ownerId === self.id,
      };
    }
    let threadId: string;
    let youOpenedIt = true;
    let openedFrom: string | undefined;
    try {
      threadId = await api.startThread(channel.id, m.id, safeClip(text || "QM", THREAD_NAME_LIMIT));
      openedFrom = channel.id;
      channels.set(threadId, { id: threadId, type: 11, parentId: channel.id, ownerId: self.id, guildId: m.guild_id! });
    } catch (error) {
      if (discordErrorCode(error) !== THREAD_ALREADY_EXISTS) throw error;
      threadId = m.id;
      youOpenedIt = (await channelOf(threadId)).ownerId === self.id;
    }
    return {
      kind: "channel",
      channelId: threadId,
      ...(openedFrom ? { openedFrom } : {}),
      threadRef: discordChannelThreadRef(channel.id, threadId),
      channelRef: channel.id,
      ...(channel.name ? { channelName: channel.name } : {}),
      youOpenedIt,
    };
  }

  async function threadContext(place: Place, trigger: DiscordMessage): Promise<Partial<CoreTurnBody>> {
    const raw = await (
      place.openedFrom
        ? api.recentMessages(place.openedFrom, CONTEXT_MESSAGES, trigger.id)
        : api.recentMessages(place.channelId, CONTEXT_MESSAGES)
    ).catch(swallowAs("discord: thread history", [] as DiscordMessage[]));
    const nameById = new Map<string, string>([[self.id, self.username]]);
    for (const m of raw) nameById.set(m.author.id, discordDisplayName(m.author));
    const messages: RecentMessage[] = raw
      .filter((m) => m.id !== trigger.id && isConversationMessage(m) && messageText(m).trim())
      .map((m) => ({
        ts: m.id,
        name: discordDisplayName(m.author),
        authorId: m.author.id,
        text: messageText(m),
        ...(m.author.bot ? { isBot: true } : {}),
        ...(m.author.id === self.id ? { isSelf: true } : {}),
      }));
    const rendered = renderConversationView({
      channel: { kind: "channel", ...(place.channelName ? { name: place.channelName } : {}) },
      members: [],
      messages,
      here: place.openedFrom ? { kind: "top-level" } : { kind: "thread", youOpenedIt: place.youOpenedIt === true },
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

  function createReplyWriter(channelId: string, onPlaceholder: (messageId: string) => Promise<void>) {
    let placeholder: string | undefined;
    let streaming = true;
    let chain: Promise<void> = Promise.resolve();
    let reply = "";
    let activity: string[] = [];
    const show = (): void => {
      if (!streaming) return;
      const status = activity.map((line) => `-# ${line}`).join("\n");
      const room = DISCORD_MESSAGE_LIMIT - 1 - (status ? status.length + 2 : 0);
      const body = reply ? safeClip(alignMarkdownTables(reply), room) : "";
      const shown = [body, status].filter(Boolean).join("\n\n");
      if (!shown.trim()) return;
      chain = chain
        .then(async () => {
          if (placeholder) return api.edit(channelId, placeholder, shown);
          const posted = await api.send(channelId, shown);
          try {
            await onPlaceholder(posted);
            placeholder = posted;
          } catch (error) {
            streaming = false;
            await api.remove(channelId, posted).catch(swallowAs("discord: remove unrecorded placeholder", undefined));
            throw error;
          }
        })
        .catch(swallowAs("discord: stream reply", undefined));
    };
    return {
      stream(text: string): void {
        reply = text;
        show();
      },
      toolCalls(calls: readonly ToolCallView[]): void {
        activity = [...activity, ...calls.map(toolCallLine)].slice(-TOOL_ACTIVITY_LINES);
        show();
      },
      async finish(text: string, key: string): Promise<void> {
        streaming = false;
        await chain;
        if (text) return postMessage(api, channelId, text, { key, ...(placeholder ? { editRef: placeholder } : {}) });
        if (placeholder) await api.remove(channelId, placeholder);
      },
    };
  }

  async function reactTo(threadId: string, messageId: string, names: readonly string[]): Promise<void> {
    const channelId = await messageHomeChannel({ channel: channelOf }, threadId, messageId).catch(
      swallowAs("discord: reaction channel", threadId),
    );
    for (const name of names.slice(0, MAX_REACTIONS)) {
      const emoji = emojiCharFor(name);
      if (emoji) await api.react(channelId, messageId, emoji).catch(swallowAs("discord: react", undefined));
    }
  }

  function replyText(result: TurnResult, addressed: boolean, dm: boolean): string {
    if (result.status === "ok") return result.reply?.trim() || (result.stopped ? "Stopped." : "");
    if (result.status === "refused" || result.status === "failed")
      return addressed ? `⚠️ ${userFacingFailureClause(result)}` : "";
    if (result.status !== "pending_approval" || !addressed) return "";
    if (!result.pendingApprovals?.length) return result.reason ?? "This conversation is waiting on a pending approval.";
    return dm ? "" : "I sent you a DM to approve before I continue.";
  }

  function startTyping(channelId: string): () => void {
    const tick = (): void => void api.typing(channelId).catch(swallowAs("discord: typing", undefined));
    tick();
    const timer = setInterval(tick, TYPING_REFRESH_MS);
    return () => clearInterval(timer);
  }

  async function inboundFiles(
    m: DiscordMessage,
    voice: VoiceNote,
  ): Promise<Pick<CoreTurnBody, "attachments" | "inboundNotes">> {
    const files = messageAttachments(m);
    const downloaded = voice.downloaded;
    const reuse: typeof fetch = (url, init) =>
      downloaded && String(url) === downloaded.url
        ? Promise.resolve(new Response(new Uint8Array(downloaded.bytes)))
        : fetch(url, init);
    const { attachments, issues } = files.length
      ? await receiveDiscordFiles(files, (bytes) => core.stageBlob(bytes), discordDisplayName(m.author), reuse)
      : { attachments: [], issues: [] };
    const notes = [...issues, ...(voice.note ? [voice.note] : [])];
    return {
      ...(attachments.length ? { attachments } : {}),
      ...(notes.length ? { inboundNotes: notes } : {}),
    };
  }

  async function voiceNote(m: DiscordMessage): Promise<VoiceNote> {
    const transcribe = core.transcribe;
    const audio = m.attachments?.find((a) => a.content_type?.startsWith("audio/"));
    const mimetype = audio?.content_type;
    if (!transcribe || !audio || !mimetype || !((m.flags ?? 0) & MessageFlags.IsVoiceMessage)) return {};
    let downloaded: VoiceNote["downloaded"];
    try {
      const bytes = await downloadDiscordFile({ id: audio.id, name: audio.filename, url_private: audio.url });
      downloaded = { url: audio.url, bytes };
      const spoken = await transcribe(bytes, audio.filename, mimetype);
      return { downloaded, ...(spoken ? { transcript: `(voice note) ${spoken}` } : {}) };
    } catch (error) {
      reportFailure("discord: voice note transcription", error, m.id);
      return {
        ...(downloaded ? { downloaded } : {}),
        note: `${discordDisplayName(m.author)} sent a voice note that couldn't be transcribed.`,
      };
    }
  }

  async function handleMessage(m: DiscordMessage, stage?: () => Promise<AcceptGate>): Promise<void> {
    const relevant = await relevantPlace(m);
    if (!relevant) return;
    const gate = await stage?.();
    if (!(await core.linkedPrincipal(m.author.id))) {
      if (relevant.addressed) await promptLink(m.author.id);
      return gate?.persisted();
    }
    const spoken = await voiceNote(m);
    const text = [messageText(m), spoken.transcript ?? ""]
      .filter((part) => part.trim())
      .join("\n")
      .replaceAll(selfMention, `@${self.username}`)
      .trim();
    if (!text && !messageAttachments(m).length) return gate?.persisted();
    const messageKey = discordMessageKey(m.channel_id, m.id);
    let place: Place;
    try {
      place = await resolvePlace(m, relevant.channel, text);
    } catch (error) {
      gate?.persisted();
      console.error(`[discord] could not open a thread for ${messageKey}: ${errMessage(error)}`);
      await api
        .send(m.channel_id, "I couldn't start a thread here. Check that I can create threads in this channel.", {
          replyTo: m.id,
        })
        .catch(swallowAs("discord: thread failure note", undefined));
      return;
    }
    if (place.channelRef && m.guild_id)
      await core.rememberChannel(place.channelRef, m.guild_id).catch(swallowAs("discord: remember channel", undefined));
    const actor: ActorAssertion = { externalId: `discord:${m.author.id}`, displayName: discordDisplayName(m.author) };
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
      origin: relevant.addressed ? { kind: "human", messageTs: m.id } : { kind: "ambient", live: true, entryTs: m.id },
      gatewayContext: {
        location: place.kind === "dm" ? "a Discord direct message with the user" : "a Discord thread",
        details: { channel: place.channelId },
        botHandle: self.username,
        ...(place.kind === "dm" ? { instructions: DISCORD_REACTION_INSTRUCTION } : {}),
      },
      redeliveryKey: messageKey,
      ...(await inboundFiles(m, spoken)),
      ...(place.kind === "channel" ? await threadContext(place, m) : {}),
    };
    await converse(place.channelId, body, {
      addressed: relevant.addressed,
      key: messageKey,
      ...(gate ? { gate } : {}),
    });
  }

  async function converse(
    channelId: string,
    body: CoreTurnBody,
    opts: { addressed: boolean; key: string; gate?: AcceptGate; quiet?: boolean },
  ): Promise<TurnOutcome> {
    const { addressed, key, gate, quiet } = opts;
    let queuedRunId: string | undefined;
    const writer = createReplyWriter(channelId, async (messageId) => {
      if (queuedRunId) await core.reportRunEditRef(queuedRunId, messageId);
    });
    let accepted = false;
    const accept = (): void => {
      accepted = true;
      gate?.persisted();
    };
    let finished = false;
    let typing = addressed;
    let stopTyping = addressed ? startTyping(channelId) : () => {};
    const typeOnceReplying = (): void => {
      if (finished || typing) return;
      typing = true;
      stopTyping = startTyping(channelId);
    };
    try {
      let result: TurnResult;
      try {
        result = await flow.callCore(body, {
          deferDeliveryAck: true,
          onQueued: (runId) => {
            queuedRunId = runId;
            accept();
          },
          onSteered: accept,
          onReplying: typeOnceReplying,
          onSnapshot: (snapshot) => {
            const text = stripReactionDirectives(snapshot);
            if (!text.trim()) return;
            writer.stream(text);
          },
          onToolCalls: (calls) => writer.toolCalls(calls),
        });
      } catch (error) {
        if (!accepted) gate?.failed(errMessage(error));
        console.error(`[discord] turn errored for ${key}: ${errMessage(error)}`);
        if (typing && !quiet)
          await writer
            .finish(`⚠️ ${turnFailureText(error)}`, `failure:${key}`)
            .catch(swallowAs("discord: failure note", undefined));
        return { accepted };
      }
      if (!accepted) accept();
      if (result.steered) return { result, accepted };
      const extracted = extractReactions(
        quiet && result.status !== "ok" ? "" : replyText(result, typing, body.conversation.kind === "dm"),
      );
      const reply = extracted.text.trim();
      const reactions = [
        ...(result.status === "react" ? (result.reactions ?? []) : []),
        ...extracted.reactions.filter((d) => !d.target && !d.targetId).flatMap((d) => d.names),
      ];
      const trigger = triggerMessageId(body);
      if (reactions.length && trigger) await reactTo(channelId, trigger, reactions);
      const runId = queuedRunId;
      try {
        await writer.finish(reply, runId ? `run:${runId}` : key);
        if (result.attachments?.length) {
          const problems = await sendDiscordFiles(api, core, channelId, result.attachments, {
            key: runId ? `run:${runId}` : key,
          });
          if (problems.length)
            await postMessage(api, channelId, `⚠️ ${problems.join("; ")}.`, {
              key: `${runId ? `run:${runId}` : key}:file-notes`,
            });
        }
      } catch (error) {
        if (runId) flow.inFlightRuns.delete(runId);
        console.error(
          `[discord] reply post failed for run ${runId ?? "?"}; leaving it for the delivery poller:`,
          errMessage(error),
        );
        return { result, accepted };
      }
      if (runId && hasRunDelivery(result)) flow.ackRunDelivery(runId);
      return { result, accepted };
    } finally {
      finished = true;
      stopTyping();
    }
  }

  async function resumeTurn(body: CoreTurnBody, key: string): Promise<TurnOutcome> {
    if (isSubagentThreadRef(body.conversation.threadRef)) {
      let accepted = false;
      return flow
        .callCore(body, {
          onQueued: () => {
            accepted = true;
          },
          onSteered: () => {
            accepted = true;
          },
        })
        .then((result) => ({ result, accepted: true }))
        .catch((error: unknown) => {
          console.error(`[discord] delegated approval ${key} errored: ${errMessage(error)}`);
          return { accepted };
        });
    }
    if (!body.deliveryTarget) return { accepted: false };
    return converse(body.deliveryTarget, body, { addressed: true, key, quiet: true });
  }

  return { handleMessage, resumeTurn };
}
