import {
  ApplicationCommandOptionType,
  InteractionType,
  type APIInteraction,
  type APIMessageComponentInteraction,
  type RESTPutAPIApplicationCommandsJSONBody,
} from "@discordjs/core";
import { errMessage } from "../util/errors.ts";
import type { DiscordApi, DiscordButton, DiscordSelect } from "./api.ts";
import { CODEX_SUBSCRIPTION_PROVIDER } from "../model/pi-models.ts";
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

type Reply = string | { content: string; buttons: DiscordButton[]; select?: DiscordSelect };

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  google: "Google",
  xai: "xAI",
  "qm:gateway": "Gateway",
};

function modelGroup(menu: ModelMenu, harnessId: string, modelId: string): { key: string; label: string } {
  if (harnessId === "claude") return { key: "claude", label: "Claude" };
  const provider = String((menu.modelCatalog[modelId] as { provider?: unknown } | undefined)?.provider ?? "other");
  if (provider === CODEX_SUBSCRIPTION_PROVIDER || modelId.startsWith("codex/"))
    return { key: "codex", label: "Codex (ChatGPT subscription)" };
  return { key: `${harnessId}~${provider}`, label: PROVIDER_LABELS[provider] ?? provider };
}

function modelGroups(menu: ModelMenu) {
  const groups = new Map<string, { label: string; models: Array<{ harnessId: string; modelId: string }> }>();
  for (const harnessId of menu.approvedHarnesses)
    for (const modelId of menu.modelsByHarness[harnessId] ?? []) {
      if (`${harnessId}:${modelId}`.length > CHOICE_TEXT_LIMIT) continue;
      const { key, label } = modelGroup(menu, harnessId, modelId);
      const group = groups.get(key) ?? { label, models: [] };
      group.models.push({ harnessId, modelId });
      groups.set(key, group);
    }
  const labels = [...groups.values()].map((g) => g.label);
  for (const [key, group] of groups)
    if (labels.filter((label) => label === group.label).length > 1)
      group.label = `${group.label} (${key.split("~")[0]})`;
  return groups;
}

const NO_MODELS = "You don't have any models to choose from here.";

function plainLabel(menu: ModelMenu, modelId: string): string {
  const meta = menu.modelCatalog[modelId];
  return meta?.label ?? meta?.name ?? modelId;
}

const CANCEL_BUTTON: DiscordButton = { id: "qm:model:cancel", label: "Cancel", style: "danger" };

async function modelPicker(
  core: DiscordCoreClient,
  api: DiscordApi,
  principal: string,
  channelId: string,
  groupKey?: string,
): Promise<Reply> {
  const threadRef = await modelThread(api, channelId);
  if (!threadRef) return NO_MODEL_HERE;
  const found = await core.modelMenu(principal, threadRef);
  if (found === undefined) return "Model selection isn't available on this QM.";
  if (!found) return MODEL_AFTER_FIRST_MESSAGE;
  const { menu, session, current, skipped } = found;
  const groups = modelGroups(menu);
  const currentGroup = modelGroup(menu, current.harnessId, current.modelId);
  const pinNote = skipped ? ` (default — **${skipped.modelId}** isn't available right now)` : "";
  const header = `⚙️ **Model for this conversation**\nCurrent: **${plainLabel(menu, current.modelId)}** · ${currentGroup.label}${session.runtime ? pinNote : " (default)"}`;
  if (!groups.size) return NO_MODELS;
  const group = groupKey ? groups.get(groupKey) : undefined;
  if (!group)
    return {
      content: `${header}\n\nChoose a provider:`,
      select: {
        id: "qm:model:group",
        placeholder: "Choose a provider…",
        options: [...groups].slice(0, CHOICE_LIMIT).map(([key, g]) => ({
          label: safeClip(
            `${g.label} (${g.models.length} model${g.models.length === 1 ? "" : "s"})`,
            CHOICE_TEXT_LIMIT,
          ),
          value: key,
          ...(key === currentGroup.key ? { description: "current" } : {}),
        })),
      },
      buttons: [
        ...(session.runtime ? [{ id: "qm:model:default", label: "Use default", style: "secondary" as const }] : []),
        CANCEL_BUTTON,
      ],
    };
  const shown = group.models;
  const more = shown.length > CHOICE_LIMIT ? "\nShowing the first 25; use `/qm model name:` for the others." : "";
  return {
    content: `${header}\n\nChoose a ${group.label} model:${more}`,
    select: {
      id: "qm:model:pick",
      placeholder: `Choose a ${group.label} model…`,
      options: shown.slice(0, CHOICE_LIMIT).map((m) => ({
        label: safeClip(plainLabel(menu, m.modelId), CHOICE_TEXT_LIMIT),
        value: `${m.harnessId}:${m.modelId}`,
        ...(m.harnessId === current.harnessId && m.modelId === current.modelId ? { selected: true } : {}),
      })),
    },
    buttons: [{ id: "qm:model:back", label: "Back", style: "secondary" }, CANCEL_BUTTON],
  };
}

async function handleModelPicker(
  core: DiscordCoreClient,
  api: DiscordApi,
  interaction: APIMessageComponentInteraction,
): Promise<void> {
  await api.deferUpdate(interaction.id, interaction.token);
  const show = (reply: Reply): Promise<void> =>
    typeof reply === "string"
      ? api.editReply(interaction.token, reply, { buttons: [] })
      : api.editReply(interaction.token, reply.content, {
          buttons: reply.buttons,
          ...(reply.select ? { select: reply.select } : {}),
        });
  const userId = interaction.member?.user.id ?? interaction.user?.id;
  const principal = userId ? await core.linkedPrincipal(userId) : undefined;
  const channelId = interaction.channel?.id ?? interaction.channel_id;
  if (!principal || !channelId) return show("Link your Discord account first with `/qm link`.");
  const { custom_id: id } = interaction.data;
  const picked = "values" in interaction.data ? interaction.data.values[0] : undefined;
  try {
    if (id === "qm:model:cancel") return await show("No change.");
    if (id === "qm:model:group") return await show(await modelPicker(core, api, principal, channelId, picked));
    if (id === "qm:model:back") return await show(await modelPicker(core, api, principal, channelId));
    if (id === "qm:model:pick" && picked) return await show(await modelAnswer(core, api, principal, channelId, picked));
    if (id === "qm:model:default") return await show(await modelAnswer(core, api, principal, channelId, "default"));
  } catch (error) {
    console.error(`[discord] model picker ${id} failed:`, errMessage(error));
    await show("That didn't work. Try again in a moment.");
  }
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
  query: string,
): Promise<string> {
  const threadRef = await modelThread(api, channelId);
  if (!threadRef) return NO_MODEL_HERE;
  const found = await core.modelMenu(principal, threadRef);
  if (found === undefined) return "Model selection isn't available on this QM.";
  if (!found) return MODEL_AFTER_FIRST_MESSAGE;
  const { menu } = found;
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
  if (result.error === "no_session") return MODEL_AFTER_FIRST_MESSAGE;
  if (result.error === "runtime_unavailable") return "Model selection isn't available on this QM.";
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
): Promise<Reply> {
  const linked = await core.linkedPrincipal(userId);
  if (subcommand === "model") {
    if (!linked) return "Link your Discord account first with `/qm link`.";
    if (!channelId) return "Run `/qm model` in my DM or a channel I work in.";
    return value ? modelAnswer(core, api, linked, channelId, value) : modelPicker(core, api, linked, channelId);
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
    if (interaction.data.custom_id.startsWith("qm:model:")) return handleModelPicker(core, api, interaction);
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
  let reply: Reply;
  try {
    reply =
      interaction.guild_id && !deps.guildIds.has(interaction.guild_id)
        ? "QM isn't enabled in this server."
        : await answer(core, api, userId, option?.name, interaction.channel?.id, optionValue(option));
  } catch (error) {
    console.error(`[discord] /qm ${option?.name ?? "?"} failed:`, errMessage(error));
    reply = "That didn't work. Try again in a moment.";
  }
  if (typeof reply === "string") await api.editReply(interaction.token, reply);
  else
    await api.editReply(interaction.token, reply.content, {
      buttons: reply.buttons,
      ...(reply.select ? { select: reply.select } : {}),
    });
}
