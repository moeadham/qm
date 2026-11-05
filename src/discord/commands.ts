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
import type { DiscordCoreClient, ModelMenu } from "./core.ts";
import { safeClip } from "../surfaces/safe-cut.ts";
import { sleep } from "../util/async.ts";

const CHOICE_LIMIT = 25;
const AUTOCOMPLETE_BUDGET_MS = 2_500;
const CHOICE_TEXT_LIMIT = 100;

const NO_MODEL_HERE = "Run `/qm model` in my DM or in a thread I'm working in.";
const MODEL_AFTER_FIRST_MESSAGE = "Send me a message here first, then run `/qm model`.";

async function modelThread(api: DiscordApi, channelId: string): Promise<string | undefined> {
  return threadRefForChannel(await api.channel(channelId));
}

function modelLabel(menu: ModelMenu, harnessId: string, modelId: string): string {
  const meta = menu.modelCatalog[modelId];
  const label = meta?.label ?? meta?.name ?? modelId;
  return menu.approvedHarnesses.length > 1 ? `${label} · ${harnessId}` : label;
}

async function modelAnswer(
  core: DiscordCoreClient,
  api: DiscordApi,
  principal: string,
  channelId: string,
  query: string | undefined,
): Promise<string> {
  const threadRef = await modelThread(api, channelId);
  if (!threadRef) return NO_MODEL_HERE;
  const found = await core.modelMenu(principal, threadRef);
  if (!found) return MODEL_AFTER_FIRST_MESSAGE;
  const { menu, session, current } = found;
  if (!query)
    return [
      `This conversation uses **${modelLabel(menu, current.harnessId, current.modelId)}**${session.runtime ? "" : " (the default)"}.`,
      "Change it with `/qm model name:` (start typing to search your models), or `default` to go back to the default.",
    ].join("\n");
  const result = await core.setModel(principal, threadRef, query.trim());
  if (result.ok)
    return result.choice
      ? `Done. This conversation now uses **${modelLabel(menu, result.choice.harnessId, result.choice.modelId)}**.`
      : "Done. This conversation uses the default model again.";
  if (result.error === "model_unavailable")
    return `I don't have a model called "${safeClip(query, 80)}" for you here. Start typing in \`/qm model name:\` to see your options.`;
  if (result.error === "model_ambiguous")
    return `"${safeClip(query, 80)}" matches more than one model: ${(result.candidates ?? [])
      .map((c) => `\`${c.harnessId}:${c.modelId}\``)
      .join(", ")}. Pick one of those.`;
  if (result.error === "no_session" || result.error === "not_found") return MODEL_AFTER_FIRST_MESSAGE;
  return `That model can't be used here: ${result.error}.`;
}

async function modelSuggestions(
  core: DiscordCoreClient,
  api: DiscordApi,
  userId: string,
  channelId: string | undefined,
  typed: string,
): Promise<Array<{ name: string; value: string }>> {
  const principal = await core.linkedPrincipal(userId);
  if (!principal || !channelId) return [];
  const threadRef = await modelThread(api, channelId);
  const found = threadRef ? await core.modelMenu(principal, threadRef, { refresh: false }) : undefined;
  if (!found) return [];
  const { menu } = found;
  const wanted = typed.trim().toLowerCase();
  const options = [
    { name: "Default (inherit the usual model)", value: "default" },
    ...menu.approvedHarnesses.flatMap((harnessId) =>
      (menu.modelsByHarness[harnessId] ?? []).map((modelId) => ({
        name: modelLabel(menu, harnessId, modelId),
        value: `${harnessId}:${modelId}`,
      })),
    ),
  ];
  return options
    .filter((o) => !wanted || o.name.toLowerCase().includes(wanted) || o.value.toLowerCase().includes(wanted))
    .filter((o) => o.value.length <= CHOICE_TEXT_LIMIT)
    .slice(0, CHOICE_LIMIT)
    .map((o) => ({ name: safeClip(o.name, CHOICE_TEXT_LIMIT), value: o.value }));
}

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
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "model",
        description: "Show or change the model this conversation uses",
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "name",
            description: "The model to use, or 'default'",
            autocomplete: true,
          },
        ],
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
  value: string | undefined,
): Promise<string> {
  const linked = await core.linkedPrincipal(userId);
  if (subcommand === "model") {
    if (!linked) return "Link your Discord account first with `/qm link`.";
    if (!channelId) return "Run `/qm model` in my DM or a channel I work in.";
    return modelAnswer(core, api, linked, channelId, value);
  }
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

function optionValue(option: unknown): string | undefined {
  const nested = (option as { options?: Array<{ value?: unknown }> } | undefined)?.options?.[0]?.value;
  return typeof nested === "string" && nested.trim() ? nested : undefined;
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
  if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
    const sub = interaction.data.options?.[0];
    const focused = sub && "options" in sub ? sub.options?.find((o) => "focused" in o && o.focused) : undefined;
    const userId = interaction.member?.user.id ?? interaction.user?.id;
    const allowed = !interaction.guild_id || deps.guildIds.has(interaction.guild_id);
    const choices =
      allowed && userId && sub?.name === "model" && focused && "value" in focused
        ? await Promise.race([
            modelSuggestions(core, api, userId, interaction.channel?.id, String(focused.value)),
            sleep(AUTOCOMPLETE_BUDGET_MS, { unref: true }).then(() => []),
          ]).catch((error: unknown) => {
            console.error("[discord] /qm model suggestions failed:", errMessage(error));
            return [];
          })
        : [];
    return api.autocomplete(interaction.id, interaction.token, choices);
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
        : await answer(core, api, userId, option?.name, interaction.channel?.id, optionValue(option));
  } catch (error) {
    console.error(`[discord] /qm ${option?.name ?? "?"} failed:`, errMessage(error));
    content = "That didn't work. Try again in a moment.";
  }
  await api.editReply(interaction.token, content);
}
