import { createHash } from "node:crypto";
import { linkedDiscordId } from "../identity/discord-link.ts";
import { drainClaimedDeliveries } from "../surfaces/delivery-claims.ts";
import { safeChunks } from "../surfaces/safe-cut.ts";
import type { TurnFlow } from "../surfaces/turn-flow.ts";
import type { Delivery } from "../types.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import type { DiscordApi } from "./api.ts";
import { DISCORD_MESSAGE_LIMIT, discordDmThreadRef } from "./bot.ts";
import type { DiscordCoreClient } from "./core.ts";

const CLAIM_MS = 15_000;
const RUN_RECOVERY_GRACE_MS = 15_000;
const UNKNOWN_MESSAGE = 10008;
const UNDELIVERABLE_CODES = new Set([10003, 10013, 50001, 50007, 50013]);
const MAX_REPORTED = 5_000;

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
}

function nonceFor(key: string, part: number): string {
  return createHash("sha256").update(`${key}:${part}`).digest("hex").slice(0, 25);
}

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

  async function post(d: Delivery, channelId: string, opts: { replyTo?: string; editRef?: string }): Promise<void> {
    const key = d.idempotencyKey ?? d.id;
    for (const [i, part] of safeChunks(d.text.trim(), DISCORD_MESSAGE_LIMIT).entries()) {
      if (i === 0 && opts.editRef) {
        try {
          await api.edit(channelId, opts.editRef, part);
          continue;
        } catch (error) {
          if (errorCode(error) !== UNKNOWN_MESSAGE) throw error;
        }
      }
      await api.send(channelId, part, {
        ...(i === 0 && opts.replyTo ? { replyTo: opts.replyTo } : {}),
        nonce: nonceFor(key, i),
      });
    }
  }

  async function attempt(d: Delivery, send: () => Promise<{ recipientThreadRef?: string } | void>): Promise<void> {
    try {
      const body = await send();
      await core.ackDelivery(d.id, body ?? undefined);
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined && UNDELIVERABLE_CODES.has(code)) reportUndeliverable(d.id, `discord error ${code}`);
      console.error(`[discord] delivery ${d.id} failed:`, errMessage(error));
    }
  }

  async function deliverConversation(d: Delivery): Promise<void> {
    const runId = d.idempotencyKey?.startsWith("run:") ? d.idempotencyKey.slice("run:".length) : undefined;
    if (runId && flow.inFlightRuns.has(runId)) return;
    if (runId && Date.now() - d.createdAt < RUN_RECOVERY_GRACE_MS) return;
    const [channelId = "", replyTo] = d.destination.target.split(":");
    await attempt(d, async () => {
      if (d.destination.delete) {
        await api.remove(channelId, d.destination.delete.messageTs).catch((error: unknown) => {
          if (errorCode(error) !== UNKNOWN_MESSAGE) throw error;
        });
        return;
      }
      if (!d.text.trim()) return;
      await post(d, channelId, {
        ...(replyTo ? { replyTo } : {}),
        ...(d.destination.editRef ? { editRef: d.destination.editRef } : {}),
      });
    });
  }

  async function deliverToPrincipal(d: Delivery): Promise<void> {
    if (d.destination.commandApprovalId || d.destination.keychainAskId || d.destination.deploymentAccess)
      return reportUndeliverable(d.id, "approval cards are not available on Discord yet");
    const discordId = linkedDiscordId(d.destination.target);
    if (!discordId) return reportUndeliverable(d.id, "recipient has no linked Discord account");
    await attempt(d, async () => {
      if (!d.text.trim()) return;
      const dm = await api.openDm(discordId);
      await post(d, dm, {});
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
