import type { DirectoryStore } from "../directory/directory-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface DiscordChannelRecord {
  channelId: string;
  guildId: string;
}

export interface DiscordChannels {
  has(channelId: string): Promise<boolean>;
  remember(channelId: string, guildId: string): Promise<void>;
}

export function createDiscordChannels(
  store: DurableMap<DiscordChannelRecord>,
  allowedGuilds: ReadonlySet<string>,
): DiscordChannels {
  const known = new Set<string>();
  return {
    async has(channelId) {
      if (known.has(channelId)) return true;
      const record = await store.get(channelId);
      if (!record || !allowedGuilds.has(record.guildId)) return false;
      known.add(channelId);
      return true;
    },
    async remember(channelId, guildId) {
      if (known.has(channelId) || !allowedGuilds.has(guildId)) return;
      await store.putIfAbsent(channelId, { channelId, guildId });
      known.add(channelId);
    },
  };
}

export function withDiscordChannels(
  directory: DirectoryStore,
  channels: DiscordChannels,
  isInternal: (principalId: string) => boolean,
): DirectoryStore {
  return {
    ...directory,
    async channelPrivacy(channelId) {
      const known = await directory.channelPrivacy(channelId);
      if (known !== undefined) return known;
      return (await channels.has(channelId)) ? false : undefined;
    },
    async channelMember(channelId, principalId) {
      if (await directory.channelMember(channelId, principalId)) return true;
      if ((await directory.channelPrivacy(channelId)) !== undefined) return false;
      return isInternal(principalId) && (await channels.has(channelId));
    },
  };
}
