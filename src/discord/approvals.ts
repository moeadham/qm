import type { APIMessageComponentInteraction } from "@discordjs/core";
import { approvalReplayTurn } from "../core/approval-store.ts";
import { samePerson } from "../directory/person.ts";
import type { CoreTurnBody } from "../surfaces/turn-flow.ts";
import type { ActorAssertion } from "../types.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import type { DiscordApi } from "./api.ts";
import {
  commandDecisionText,
  keychainCard,
  parseApprovalButton,
  type ApprovalButton,
  type DiscordCard,
} from "./approval-cards.ts";
import type { DiscordCoreClient } from "./core.ts";

export function createApprovalButtons(deps: {
  api: DiscordApi;
  core: DiscordCoreClient;
  resumeTurn(body: CoreTurnBody, key: string): Promise<void>;
}) {
  const { api, core } = deps;

  async function decideCommand(
    button: ApprovalButton & { kind: "command" },
    clicker: ActorAssertion,
  ): Promise<{ card?: DiscordCard; note?: string; resume?: () => Promise<void> }> {
    const record = await core.getApproval(button.id);
    if (!record?.request)
      return { card: { content: "That approval request expired. Ask me again when you want to retry.", buttons: [] } };
    const requester = (record.request.actor as { externalId?: unknown } | undefined)?.externalId;
    if (typeof requester !== "string" || !samePerson(clicker.externalId, requester))
      return { note: "Only the person who asked can approve or deny this." };
    const approved = button.scope !== "deny";
    const body = {
      ...approvalReplayTurn(record.request),
      actor: clicker,
      approval: { requestId: button.id, approved, ...(approved ? { scope: button.scope } : {}) },
      idempotencyKey: `discord-approval:${button.id}:${record.createdAt ?? 0}`,
    } as CoreTurnBody;
    return {
      card: { content: commandDecisionText(button.scope, record.command), buttons: [] },
      resume: () => deps.resumeTurn(body, `approval:${button.id}`),
    };
  }

  async function decide(
    button: ApprovalButton,
    clicker: ActorAssertion,
  ): Promise<{ card?: DiscordCard; note?: string; resume?: () => Promise<void> }> {
    if (button.kind === "command") return decideCommand(button, clicker);
    if (button.kind === "keychain") {
      if (!core.keychainApprovals) return { note: "Credential approvals aren't available on this QM." };
      return { card: keychainCard(await core.keychainApprovals.decide(button.id, clicker, button.decision)) };
    }
    const request = await core.deploymentAccessRequest(button.id);
    if (!request) return { card: { content: "That access request is no longer available.", buttons: [] } };
    return { card: { content: await core.decideDeploymentAccess(request, clicker, button.approve), buttons: [] } };
  }

  async function handle(interaction: APIMessageComponentInteraction): Promise<void> {
    const button = parseApprovalButton(interaction.data.custom_id);
    const user = interaction.member?.user ?? interaction.user;
    if (!button || !user) return;
    await api.deferUpdate(interaction.id, interaction.token);
    const tell = (text: string): Promise<void> =>
      api.followUpEphemeral(interaction.token, text).catch(swallowAs("discord: approval note", undefined));
    if (!(await core.linkedPrincipal(user.id))) return tell("Link your Discord account first with `/qm link`.");
    const clicker: ActorAssertion = {
      externalId: `discord:${user.id}`,
      displayName: user.global_name || user.username,
    };
    let outcome: Awaited<ReturnType<typeof decide>>;
    try {
      outcome = await decide(button, clicker);
    } catch (error) {
      console.error(`[discord] approval button ${interaction.data.custom_id} failed:`, errMessage(error));
      return tell(`Couldn't complete that: ${errMessage(error)} You can try the button again.`);
    }
    if (outcome.note) await tell(outcome.note);
    if (outcome.card)
      await api
        .edit(interaction.message.channel_id, interaction.message.id, outcome.card.content, {
          buttons: outcome.card.buttons,
        })
        .catch(swallowAs("discord: update approval card", undefined));
    await outcome.resume?.();
  }

  return { handle };
}
