import type { APIMessageComponentInteraction } from "@discordjs/core";
import { approvalReplayTurn } from "../core/approval-store.ts";
import { userFacingFailureClause } from "../core/failure-copy.ts";
import { samePerson } from "../directory/person.ts";
import { isSubagentThreadRef } from "../sessions/session-syscalls.ts";
import type { StoredApprovalView } from "../surfaces/surface-core-client.ts";
import type { CoreTurnBody } from "../surfaces/turn-flow.ts";
import type { ActorAssertion, TurnResult } from "../types.ts";
import { createKeyedQueue } from "../util/async.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { discordDisplayName, type DiscordApi } from "./api.ts";
import {
  commandApprovalCard,
  commandDecisionText,
  keychainCard,
  parseApprovalButton,
  type ApprovalButton,
  type DiscordCard,
} from "./approval-cards.ts";
import type { TurnOutcome } from "./bot.ts";
import type { DiscordCoreClient } from "./core.ts";

function stillPending({ result, accepted }: TurnOutcome, requestId: string): boolean {
  if (!result) return !accepted;
  if (result.status !== "pending_approval") return false;
  const pending = result.pendingApprovals ?? [];
  return !pending.length || pending.some((p) => p.requestId === requestId);
}

export function createApprovalButtons(deps: {
  api: DiscordApi;
  core: DiscordCoreClient;
  resumeTurn(body: CoreTurnBody, key: string): Promise<TurnOutcome>;
}) {
  const { api, core } = deps;
  const oneAtATime = createKeyedQueue();

  async function decideCommand(
    button: ApprovalButton & { kind: "command" },
    clicker: ActorAssertion,
    show: (card: DiscordCard) => Promise<void>,
    tell: (text: string) => Promise<void>,
    retire: () => Promise<void>,
  ): Promise<void> {
    const record = await core.getApproval(button.id);
    if (!record?.request) {
      await retire();
      return tell("That approval was already decided or has expired.");
    }
    const requester = (record.request.actor as { externalId?: unknown } | undefined)?.externalId;
    if (typeof requester !== "string" || !samePerson(clicker.externalId, requester))
      return tell("Only the person who asked can approve or deny this.");
    const approved = button.scope !== "deny";
    const body = {
      ...approvalReplayTurn(record.request),
      actor: clicker,
      approval: { requestId: button.id, approved, ...(approved ? { scope: button.scope } : {}) },
    } as CoreTurnBody;
    const decision = commandDecisionText(button.scope, record.command);
    await show({ content: decision, buttons: [] });
    const outcome = await deps.resumeTurn(body, `approval:${button.id}`);
    const { result } = outcome;
    if (stillPending(outcome, button.id)) return show(retryCard(record, result));
    if (result?.status === "failed" || result?.status === "refused")
      return show({ content: `${decision}\n⚠️ I couldn't continue: ${userFacingFailureClause(result)}.`, buttons: [] });
    if (isSubagentThreadRef(body.conversation.threadRef) && approved)
      return show({ content: `${decision}\nResults will return to the original conversation.`, buttons: [] });
  }

  function retryCard(record: StoredApprovalView, result: TurnResult | undefined): DiscordCard {
    const card = commandApprovalCard(record);
    const note = result?.reason ?? "That didn't go through.";
    return { ...card, content: `⚠️ ${note} The approval is still pending; try again.\n${card.content}` };
  }

  async function decide(
    button: ApprovalButton,
    clicker: ActorAssertion,
    show: (card: DiscordCard) => Promise<void>,
    tell: (text: string) => Promise<void>,
    retire: () => Promise<void>,
  ): Promise<void> {
    if (button.kind === "command") return decideCommand(button, clicker, show, tell, retire);
    if (button.kind === "keychain") {
      if (!core.keychainApprovals) return tell("Credential approvals aren't available on this QM.");
      return show(keychainCard(await core.keychainApprovals.decide(button.id, clicker, button.decision)));
    }
    const request = await core.deploymentAccessRequest(button.id);
    if (!request) {
      await retire();
      return tell("That access request is no longer available.");
    }
    return show({ content: await core.decideDeploymentAccess(request, clicker, button.approve), buttons: [] });
  }

  async function handle(interaction: APIMessageComponentInteraction): Promise<void> {
    const button = parseApprovalButton(interaction.data.custom_id);
    const user = interaction.member?.user ?? interaction.user;
    if (!button || !user) return;
    await api.deferUpdate(interaction.id, interaction.token);
    const { channel_id: channelId, id: messageId, content } = interaction.message;
    const tell = (text: string): Promise<void> =>
      api.followUpEphemeral(interaction.token, text).catch(swallowAs("discord: approval note", undefined));
    const show = (card: DiscordCard): Promise<void> =>
      api
        .edit(channelId, messageId, card.content, { buttons: card.buttons })
        .catch(swallowAs("discord: update approval card", undefined));
    const retire = (): Promise<void> => show({ content, buttons: [] });
    if (!(await core.linkedPrincipal(user.id))) return tell("Link your Discord account first with `/qm link`.");
    const clicker: ActorAssertion = {
      externalId: `discord:${user.id}`,
      displayName: discordDisplayName(user),
    };
    await oneAtATime(`${button.kind}:${button.id}`, async () => {
      try {
        await decide(button, clicker, show, tell, retire);
      } catch (error) {
        console.error(`[discord] approval button ${interaction.data.custom_id} failed:`, errMessage(error));
        await tell(`Couldn't complete that: ${errMessage(error)}`);
      }
    });
  }

  return { handle };
}
