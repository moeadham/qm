import {
  ApplicationCommandOptionType,
  InteractionType,
  type APIInteraction,
  type APIMessageComponentInteraction,
  type RESTPutAPIApplicationCommandsJSONBody,
} from "@discordjs/core";
import { errMessage } from "../util/errors.ts";
import type { DiscordApi } from "./api.ts";
import { threadRefForChannel } from "./bot.ts";
import type { DiscordCoreClient } from "./core.ts";

const GUILD_CONTEXT = 0;
const BOT_DM_CONTEXT = 1;
const GUILD_INSTALL = 0;

export const QM_COMMANDS: RESTPutAPIApplicationCommandsJSONBody = [
  {
    name: "qm",
    description: "Manage QM in Discord",
    contexts: [GUILD_CONTEXT, BOT_DM_CONTEXT],
    integration_types: [GUILD_INSTALL],
    options: [
      { type: ApplicationCommandOptionType.Subcommand, name: "link", description: "Link your Discord account to QM" },
      { type: ApplicationCommandOptionType.Subcommand, name: "unlink", description: "Unlink your Discord account" },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "stop",
        description: "Stop QM's work in this conversation",
      },
    ],
  },
];

async function answer(
  core: DiscordCoreClient,
  api: DiscordApi,
  userId: string,
  subcommand: string | undefined,
  channelId: string | undefined,
): Promise<string> {
  const linked = await core.linkedPrincipal(userId);
  if (subcommand === "link") {
    if (linked) return `Your Discord account is already linked to ${linked}.`;
    const url = await core.linkUrl(userId);
    return url ? `Link your account here: ${url}` : "Discord account linking isn't set up on this QM yet.";
  }
  if (subcommand === "unlink")
    return (await core.unlink(userId))
      ? "Unlinked. I won't respond to you until you link again."
      : "Your Discord account isn't linked.";
  if (subcommand === "stop") {
    if (!linked) return "Link your Discord account first with `/qm link`.";
    const threadRef = channelId ? threadRefForChannel(await api.channel(channelId)) : undefined;
    if (!threadRef) return "Run `/qm stop` in my DM or in a thread I'm working in.";
    return (await core.stopConversation(threadRef)) ? "Stopped." : "Nothing is running here.";
  }
  return "Unknown command.";
}

export async function handleInteraction(
  deps: {
    core: DiscordCoreClient;
    api: DiscordApi;
    guildIds: ReadonlySet<string>;
    buttons: { handle(interaction: APIMessageComponentInteraction): Promise<void> };
  },
  interaction: APIInteraction,
): Promise<void> {
  const { core, api } = deps;
  if (interaction.type === InteractionType.MessageComponent) {
    if (interaction.guild_id && !deps.guildIds.has(interaction.guild_id)) return;
    return deps.buttons.handle(interaction);
  }
  if (interaction.type !== InteractionType.ApplicationCommand || interaction.data.name !== "qm") return;
  const userId = interaction.member?.user.id ?? interaction.user?.id;
  if (!userId) return;
  const option = "options" in interaction.data ? interaction.data.options?.[0] : undefined;
  await api.deferEphemeral(interaction.id, interaction.token);
  let content: string;
  try {
    content =
      interaction.guild_id && !deps.guildIds.has(interaction.guild_id)
        ? "QM isn't enabled in this server."
        : await answer(core, api, userId, option?.name, interaction.channel?.id);
  } catch (error) {
    console.error(`[discord] /qm ${option?.name ?? "?"} failed:`, errMessage(error));
    content = "That didn't work. Try again in a moment.";
  }
  await api.editReply(interaction.token, content);
}
