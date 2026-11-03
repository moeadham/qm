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
import { REST } from "@discordjs/rest";
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
  replyEphemeral(interactionId: string, token: string, content: string): Promise<void>;
}

export interface DiscordGatewayHandlers {
  onMessage(message: DiscordMessage): void;
  onInteraction(interaction: APIInteraction): void;
}

export interface DiscordConnection {
  close(): Promise<void>;
}

export interface DiscordGateway {
  connect(handlers: DiscordGatewayHandlers): Promise<DiscordConnection>;
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
    async replyEphemeral(interactionId, token, content) {
      await api.interactions.reply(interactionId, token, { content, flags: MessageFlags.Ephemeral });
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
    async connect(handlers) {
      const gateway = new WebSocketManager({ token, intents: INTENTS, rest });
      const client = new Client({ rest, gateway });
      client.on(GatewayDispatchEvents.MessageCreate, ({ data }) => handlers.onMessage(data));
      client.on(GatewayDispatchEvents.InteractionCreate, ({ data }) => handlers.onInteraction(data));
      gateway.on("error", (error) => console.error("[discord] gateway error:", error.message));
      try {
        await gateway.connect();
      } catch (error) {
        await Promise.resolve(gateway.destroy()).catch(swallowAs("discord: destroy failed gateway", undefined));
        throw error;
      }
      return { close: async () => gateway.destroy() };
    },
  };
}
