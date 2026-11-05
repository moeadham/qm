import {
  API,
  AllowedMentionsTypes,
  ButtonStyle,
  Client,
  ComponentType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageFlags,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIChannel,
  type APIInteraction,
  type APIMessage,
  type RESTPutAPIApplicationCommandsJSONBody,
} from "@discordjs/core";
import { createHash } from "node:crypto";
import { REST } from "@discordjs/rest";
import { safeChunks } from "../surfaces/safe-cut.ts";
import { swallowAs } from "../util/errors.ts";
import { sleep } from "../util/async.ts";
import {
  SimpleContextFetchingStrategy,
  WebSocketManager,
  WebSocketShard,
  WebSocketShardEvents,
  managerToFetchingStrategyOptions,
  type IShardingStrategy,
  type SessionInfo,
} from "@discordjs/ws";

export type DiscordMessage = Pick<APIMessage, "id" | "channel_id" | "content" | "timestamp" | "mentions" | "type"> & {
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

export interface DiscordButton {
  id: string;
  label: string;
  style: "primary" | "secondary" | "danger";
}

export interface DiscordSelect {
  id: string;
  placeholder: string;
  options: Array<{ label: string; value: string; description?: string; selected?: boolean }>;
}

export interface DiscordApi {
  me(): Promise<{ id: string; username: string }>;
  send(
    channelId: string,
    content: string,
    opts?: { replyTo?: string; nonce?: string; buttons?: DiscordButton[] },
  ): Promise<string>;
  edit(channelId: string, messageId: string, content: string, opts?: { buttons?: DiscordButton[] }): Promise<void>;
  remove(channelId: string, messageId: string): Promise<void>;
  typing(channelId: string): Promise<void>;
  openDm(userId: string): Promise<string>;
  startThread(channelId: string, messageId: string, name: string): Promise<string>;
  channel(channelId: string): Promise<DiscordChannel>;
  recentMessages(channelId: string, limit: number): Promise<DiscordMessage[]>;
  registerCommands(commands: RESTPutAPIApplicationCommandsJSONBody): Promise<void>;
  deferEphemeral(interactionId: string, token: string): Promise<void>;
  editReply(
    token: string,
    content: string,
    opts?: { buttons?: DiscordButton[]; select?: DiscordSelect },
  ): Promise<void>;
  deferUpdate(interactionId: string, token: string): Promise<void>;
  autocomplete(interactionId: string, token: string, choices: Array<{ name: string; value: string }>): Promise<void>;
  followUpEphemeral(token: string, content: string): Promise<void>;
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
const CLOSE_WAIT_MS = 5_000;
export const DISCORD_UNKNOWN_MESSAGE = 10008;

export function discordErrorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
}

export function messageNonce(key: string, part: number): string {
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

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  danger: ButtonStyle.Danger,
} as const;

export function components(
  buttons: DiscordButton[] | undefined,
  select?: DiscordSelect,
): {
  components?: APIActionRowComponent<APIComponentInMessageActionRow>[];
} {
  if (!buttons && !select) return {};
  const rows: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];
  if (select)
    rows.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: select.id,
          placeholder: select.placeholder,
          options: select.options.map((o) => ({
            label: o.label,
            value: o.value,
            ...(o.description ? { description: o.description } : {}),
            ...(o.selected ? { default: true } : {}),
          })),
        },
      ],
    });
  if (buttons?.length)
    rows.push({
      type: ComponentType.ActionRow,
      components: buttons.map((b) => ({
        type: ComponentType.Button,
        custom_id: b.id,
        label: b.label,
        style: BUTTON_STYLES[b.style],
      })),
    });
  return { components: rows };
}

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
        ...components(opts.buttons),
      });
      return message.id;
    },
    async edit(channelId, messageId, content, opts = {}) {
      await api.channels.editMessage(channelId, messageId, {
        content,
        allowed_mentions: NO_PINGS_EXCEPT_USERS,
        ...components(opts.buttons),
      });
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
    async editReply(token, content, opts = {}) {
      await api.interactions.editReply(applicationId, token, {
        content,
        ...components(opts.buttons ?? (opts.select ? [] : undefined), opts.select),
      });
    },
    async autocomplete(interactionId, token, choices) {
      await api.interactions.createAutocompleteResponse(interactionId, token, { choices });
    },
    async deferUpdate(interactionId, token) {
      await api.interactions.deferMessageUpdate(interactionId, token);
    },
    async followUpEphemeral(token, content) {
      await api.interactions.followUp(applicationId, token, { content, flags: MessageFlags.Ephemeral });
    },
  };
}

const INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.MessageContent |
  GatewayIntentBits.DirectMessages;

function retainedShardStrategy(manager: WebSocketManager, shards: Map<number, WebSocketShard>): IShardingStrategy {
  return {
    async spawn(shardIds) {
      const options = await managerToFetchingStrategyOptions(manager);
      for (const id of shardIds) {
        const shard = new WebSocketShard(new SimpleContextFetchingStrategy(manager, options), id);
        for (const event of Object.values(WebSocketShardEvents))
          shard.on(event, (...args: unknown[]) => (manager.emit as (...a: unknown[]) => boolean)(event, ...args, id));
        shards.set(id, shard);
      }
    },
    async connect() {
      await Promise.all([...shards.values()].map((shard) => shard.connect()));
    },
    async destroy(options) {
      await Promise.all([...shards.values()].map((shard) => shard.destroy(options)));
    },
    async send(id, payload) {
      const shard = shards.get(id);
      if (!shard) throw new RangeError(`Discord shard ${id} not found`);
      await shard.send(payload);
    },
    fetchStatus() {
      return new Map([...shards].map(([id, shard]) => [id, shard.status])) as unknown as Awaited<
        ReturnType<IShardingStrategy["fetchStatus"]>
      >;
    },
  };
}

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
      const shards = new Map<number, WebSocketShard>();
      const sessions = new Map<number, SessionInfo | null>();
      const gateway = new WebSocketManager({
        token,
        intents: INTENTS,
        rest: gatedRest,
        buildStrategy: (manager) => retainedShardStrategy(manager, shards),
        retrieveSessionInfo: (id) => sessions.get(id) ?? null,
        updateSessionInfo: (id, info) => void sessions.set(id, info),
      });
      const client = new Client({ rest, gateway });
      client.on(GatewayDispatchEvents.MessageCreate, ({ data }) => {
        if (!closing) handlers.onMessage(data);
      });
      client.on(GatewayDispatchEvents.InteractionCreate, ({ data }) => {
        if (!closing) handlers.onInteraction(data);
      });
      let fail!: (error: Error) => void;
      const closed = new Promise<Error>((resolve) => (fail = resolve));
      let destroying: Promise<void> | undefined;
      const destroy = (): Promise<void> =>
        (destroying ??= Promise.race([
          Promise.resolve(gateway.destroy()).catch(swallowAs("discord: destroy gateway", undefined)),
          sleep(CLOSE_WAIT_MS, { unref: true }),
        ]).finally(() => {
          destroying = undefined;
        }));
      const destroyIfClosing = (): void => {
        if (!closing) return;
        const pending = destroying ?? Promise.resolve();
        setTimeout(() => void pending.then(destroy), 0);
      };
      gateway.on("error", (error) => fail(error));
      gateway.on("ready", destroyIfClosing);
      gateway.on("resumed", destroyIfClosing);
      const ready = gateway.connect();
      ready.catch(() => {});
      return {
        ready,
        closed,
        close: async () => {
          closing = true;
          const settled = await Promise.race([
            ready.then(
              () => true,
              () => true,
            ),
            sleep(CLOSE_WAIT_MS, { unref: true }).then(() => false),
          ]);
          if (settled) await destroy();
        },
      };
    },
  };
}
