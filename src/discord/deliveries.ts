import { approvalDeliveryKey, approvalDeliveryRecipient } from "../core/approval-store.ts";
import { samePerson } from "../directory/person.ts";
import { linkedDiscordId } from "../identity/discord-link.ts";
import { drainClaimedDeliveries } from "../surfaces/delivery-claims.ts";
import type { TurnFlow } from "../surfaces/turn-flow.ts";
import type { Delivery } from "../types.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { DISCORD_UNKNOWN_MESSAGE, discordErrorCode, messageNonce, postMessage, type DiscordApi } from "./api.ts";
import { commandApprovalCard, deployAccessCard, keychainCard, type DiscordCard } from "./approval-cards.ts";
import { discordDmThreadRef } from "./bot.ts";
import type { DiscordCoreClient } from "./core.ts";
import { sendDiscordFiles } from "./files.ts";

const CLAIM_MS = 15_000;
const RUN_RECOVERY_GRACE_MS = 15_000;
const UNDELIVERABLE_CODES = new Set([10003, 10013, 50001, 50007, 50013]);
const MAX_REPORTED = 5_000;

export function createDiscordDeliveryPoller(deps: {
  api: DiscordApi;
  core: DiscordCoreClient;
  flow: Pick<TurnFlow, "inFlightRuns">;
  claimMs?: number;
}): { poll(): Promise<boolean> } {
  const { api, core, flow } = deps;
  const claimMs = deps.claimMs ?? CLAIM_MS;
  const reported = new Set<string>();

  const reportUndeliverable = (id: string, reason: string): void => {
    if (reported.has(id)) return;
    if (reported.size >= MAX_REPORTED) reported.clear();
    reported.add(id);
    void core.reportDeliveryUndeliverable?.(id, reason).catch(swallowAs("discord: undeliverable report", undefined));
  };

  async function attempt(d: Delivery, send: () => Promise<{ recipientThreadRef?: string } | void>): Promise<void> {
    try {
      const body = await send();
      await core.ackDelivery(d.id, body ?? undefined);
    } catch (error) {
      const code = discordErrorCode(error);
      if (code !== undefined && UNDELIVERABLE_CODES.has(code)) reportUndeliverable(d.id, `discord error ${code}`);
      console.error(`[discord] delivery ${d.id} failed:`, errMessage(error));
    }
  }

  async function approvalCard(d: Delivery): Promise<DiscordCard | "skip" | undefined> {
    const { commandApprovalId, keychainAskId, deploymentAccess } = d.destination;
    if (keychainAskId) {
      if (d.idempotencyKey !== `ask:${keychainAskId}:notice`) return "skip";
      const view = await core.keychainApprovals?.card(keychainAskId);
      return view?.ask.status === "pending" ? keychainCard(view) : "skip";
    }
    if (commandApprovalId) {
      const approval = await core.getApproval(commandApprovalId);
      const requester = approvalDeliveryRecipient(approval?.request?.actor as { externalId?: string } | undefined);
      if (
        !approval ||
        !requester ||
        !samePerson(requester, d.destination.target) ||
        d.idempotencyKey !== approvalDeliveryKey(commandApprovalId, approval)
      )
        return "skip";
      return commandApprovalCard(approval);
    }
    if (deploymentAccess) return deployAccessCard(d.text, d.id);
    return undefined;
  }

  async function postCard(channelId: string, d: Delivery, card: DiscordCard): Promise<void> {
    await api.send(channelId, card.content, {
      buttons: card.buttons,
      nonce: messageNonce(d.idempotencyKey ?? d.id, 0),
    });
  }

  async function deliverConversation(d: Delivery): Promise<void> {
    const runId = d.idempotencyKey?.startsWith("run:") ? d.idempotencyKey.slice("run:".length) : undefined;
    if (runId && flow.inFlightRuns.has(runId)) return;
    if (runId && Date.now() - d.createdAt < RUN_RECOVERY_GRACE_MS) return;
    const [channelId = "", replyTo] = d.destination.target.split(":");
    await attempt(d, async () => {
      if (d.destination.delete) {
        await api.remove(channelId, d.destination.delete.messageTs).catch((error: unknown) => {
          if (discordErrorCode(error) !== DISCORD_UNKNOWN_MESSAGE) throw error;
        });
        return;
      }
      const card = await approvalCard(d);
      if (card === "skip") return;
      if (card) return postCard(channelId, d, card);
      if (d.destination.react || d.destination.pin)
        console.log(`[discord] delivery ${d.id}: reactions and pins are not delivered on Discord yet`);
      const key = d.idempotencyKey ?? d.id;
      if (d.text.trim())
        await postMessage(api, channelId, d.text.trim(), {
          key,
          ...(replyTo ? { replyTo } : {}),
          ...(d.destination.editRef ? { editRef: d.destination.editRef } : {}),
        });
      if (!d.attachments?.length) return;
      const problems = await sendDiscordFiles(api, core, channelId, d.attachments, {
        key,
        ...(replyTo && !d.text.trim() ? { replyTo } : {}),
      });
      if (problems.length)
        await postMessage(api, channelId, `⚠️ ${problems.join("; ")}.`, { key: `${key}:file-notes` });
    });
  }

  async function deliverToPrincipal(d: Delivery): Promise<void> {
    const discordId = linkedDiscordId(d.destination.target);
    if (!discordId) return reportUndeliverable(d.id, "recipient has no linked Discord account");
    await attempt(d, async () => {
      const card = await approvalCard(d);
      if (card === "skip") return;
      if (card) {
        const dm = await api.openDm(discordId);
        await postCard(dm, d, card);
        return { recipientThreadRef: discordDmThreadRef(dm) };
      }
      if (!d.text.trim()) return;
      const dm = await api.openDm(discordId);
      await postMessage(api, dm, d.text.trim(), { key: d.idempotencyKey ?? d.id });
      return { recipientThreadRef: discordDmThreadRef(dm) };
    });
  }

  async function poll(): Promise<boolean> {
    const ran = await core.holdLease("delivery-dispatch", async (lost) => {
      let lostFlag = false;
      void lost.then(() => {
        lostFlag = true;
      });
      const drain = (types: string[], deliver: (d: Delivery) => Promise<void>) =>
        drainClaimedDeliveries({
          claim: (type, ms) => core.claimDeliveries(type, ms),
          types,
          claimMs,
          deliver,
          leaseLost: () => lostFlag,
          label: "discord",
        });
      await Promise.all([drain(["discord"], deliverConversation), drain(["principal"], deliverToPrincipal)]);
      return !lostFlag;
    });
    return ran === true;
  }

  return { poll };
}
