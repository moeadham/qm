import {
  API,
  AllowedMentionsTypes,
  Client,
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageFlags,
  type APIChannel,
  type APIInteraction,
  type APIMessage,
  type RESTPutAPIApplicationCommandsJSONBody,
} from "@discordjs/core";
import { createHash } from "node:crypto";
import { REST } from "@discordjs/rest";
import { safeChunks } from "../surfaces/safe-cut.ts";
import { swallowAs } from "../util/errors.ts";
import { WebSocketManager } from "@discordjs/ws";

export type DiscordMessage = Pick<APIMessage, "id" | "channel_id" | "content" | "timestamp" | "mentions"> & {
  guild_id?: string;
  webhook_id?: string;
  author: Pick<APIMessage["author"], "id" | "username" | "global_name" | "bot">;
};

export interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  parentId?: string;
  ownerId?: string;
  guildId?: string;
}

export interface DiscordApi {
  me(): Promise<{ id: string; username: string }>;
  send(channelId: string, content: string, opts?: { replyTo?: string; nonce?: string }): Promise<string>;
  edit(channelId: string, messageId: string, content: string): Promise<void>;
  remove(channelId: string, messageId: string): Promise<void>;
  typing(channelId: string): Promise<void>;
  openDm(userId: string): Promise<string>;
  startThread(channelId: string, messageId: string, name: string): Promise<string>;
  channel(channelId: string): Promise<DiscordChannel>;
  recentMessages(channelId: string, limit: number): Promise<DiscordMessage[]>;
  registerCommands(commands: RESTPutAPIApplicationCommandsJSONBody): Promise<void>;
  deferEphemeral(interactionId: string, token: string): Promise<void>;
  editReply(token: string, content: string): Promise<void>;
}

export interface DiscordGatewayHandlers {
  onMessage(message: DiscordMessage): void;
  onInteraction(interaction: APIInteraction): void;
}

interface DiscordConnection {
  ready: Promise<void>;
  closed: Promise<Error>;
  close(): Promise<void>;
}

export interface DiscordGateway {
  open(handlers: DiscordGatewayHandlers): DiscordConnection;
}

export const DISCORD_MESSAGE_LIMIT = 2_000;
export const DISCORD_UNKNOWN_MESSAGE = 10008;

export function discordErrorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
}

function messageNonce(key: string, part: number): string {
  return createHash("sha256").update(`${key}:${part}`).digest("hex").slice(0, 25);
}

export async function postMessage(
  api: DiscordApi,
  channelId: string,
  text: string,
  opts: { key: string; editRef?: string; replyTo?: string },
): Promise<void> {
  for (const [i, part] of safeChunks(text, DISCORD_MESSAGE_LIMIT).entries()) {
    if (i === 0 && opts.editRef) {
      try {
        await api.edit(channelId, opts.editRef, part);
        continue;
      } catch (error) {
        if (discordErrorCode(error) !== DISCORD_UNKNOWN_MESSAGE) throw error;
      }
    }
    await api.send(channelId, part, {
      ...(i === 0 && opts.replyTo ? { replyTo: opts.replyTo } : {}),
      nonce: messageNonce(opts.key, i),
    });
  }
}

const NO_PINGS_EXCEPT_USERS = { parse: [AllowedMentionsTypes.User] };

function toChannel(c: APIChannel): DiscordChannel {
  const raw = c as APIChannel & {
    parent_id?: string | null;
    owner_id?: string;
    guild_id?: string;
    name?: string | null;
  };
  return {
    id: raw.id,
    type: raw.type,
    ...(raw.name ? { name: raw.name } : {}),
    ...(raw.parent_id ? { parentId: raw.parent_id } : {}),
    ...(raw.owner_id ? { ownerId: raw.owner_id } : {}),
    ...(raw.guild_id ? { guildId: raw.guild_id } : {}),
  };
}

export function createDiscordRest(token: string): REST {
  return new REST({ version: "10" }).setToken(token);
}

export function createDiscordApi(rest: REST, applicationId: string): DiscordApi {
  const api = new API(rest);
  return {
    async me() {
      const user = await api.users.getCurrent();
      return { id: user.id, username: user.username };
    },
    async send(channelId, content, opts = {}) {
      const message = await api.channels.createMessage(channelId, {
        content,
        allowed_mentions: NO_PINGS_EXCEPT_USERS,
        ...(opts.replyTo ? { message_reference: { message_id: opts.replyTo, fail_if_not_exists: false } } : {}),
        ...(opts.nonce ? { nonce: opts.nonce, enforce_nonce: true } : {}),
      });
      return message.id;
    },
    async edit(channelId, messageId, content) {
      await api.channels.editMessage(channelId, messageId, { content, allowed_mentions: NO_PINGS_EXCEPT_USERS });
    },
    async remove(channelId, messageId) {
      await api.channels.deleteMessage(channelId, messageId);
    },
    async typing(channelId) {
      await api.channels.showTyping(channelId);
    },
    async openDm(userId) {
      return (await api.users.createDM(userId)).id;
    },
    async startThread(channelId, messageId, name) {
      return (await api.channels.createThread(channelId, { name }, messageId)).id;
    },
    async channel(channelId) {
      return toChannel(await api.channels.get(channelId));
    },
    async recentMessages(channelId, limit) {
      return (await api.channels.getMessages(channelId, { limit })) as DiscordMessage[];
    },
    async registerCommands(commands) {
      await api.applicationCommands.bulkOverwriteGlobalCommands(applicationId, commands);
    },
    async deferEphemeral(interactionId, token) {
      await api.interactions.defer(interactionId, token, { flags: MessageFlags.Ephemeral });
    },
    async editReply(token, content) {
      await api.interactions.editReply(applicationId, token, { content });
    },
  };
}

const INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.MessageContent |
  GatewayIntentBits.DirectMessages;

export function createDiscordGateway(token: string, rest: REST): DiscordGateway {
  return {
    open(handlers) {
      let closing = false;
      const gatedRest = {
        async get(...args: Parameters<REST["get"]>) {
          const result = await rest.get(...args);
          if (closing) throw new Error("Discord gateway closed while connecting");
          return result;
        },
      } as unknown as REST;
      const gateway = new WebSocketManager({ token, intents: INTENTS, rest: gatedRest });
      const client = new Client({ rest, gateway });
      client.on(GatewayDispatchEvents.MessageCreate, ({ data }) => handlers.onMessage(data));
      client.on(GatewayDispatchEvents.InteractionCreate, ({ data }) => handlers.onInteraction(data));
      let fail!: (error: Error) => void;
      const closed = new Promise<Error>((resolve) => (fail = resolve));
      const destroy = async (): Promise<void> => {
        await Promise.resolve(gateway.destroy()).catch(swallowAs("discord: destroy gateway", undefined));
      };
      gateway.on("error", (error) => fail(error));
      const ready = gateway.connect();
      ready.catch(() => {});
      return {
        ready,
        closed,
        close: async () => {
          closing = true;
          await destroy();
        },
      };
    },
  };
}
