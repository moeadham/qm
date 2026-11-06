export interface DiscordConfig {
  botToken: string;
  applicationId: string;
  guildIds: ReadonlySet<string>;
}

export function discordConfigFromEnv(env: NodeJS.ProcessEnv): DiscordConfig | null {
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  if (!botToken) return null;
  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  if (!applicationId) throw new Error("DISCORD_BOT_TOKEN is set but DISCORD_APPLICATION_ID is not");
  const guildIds = new Set(
    (env.DISCORD_GUILD_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (!guildIds.size) throw new Error("DISCORD_BOT_TOKEN is set but DISCORD_GUILD_IDS lists no servers");
  return { botToken, applicationId, guildIds };
}

export function assertOneChatPlatform(discord: DiscordConfig | null, slackConfigured: boolean): void {
  if (discord && slackConfigured)
    throw new Error(
      "Slack and Discord are both configured; an instance runs one chat platform. Remove the Slack tokens and installation, or the DISCORD_* variables.",
    );
}
