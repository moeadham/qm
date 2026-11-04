import { swallowAs } from "../util/errors.ts";
import type { PendingApprovalRecord } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { principalDestination } from "../reach/reach.ts";
import { isChatSurface } from "../surfaces/chat-surface.ts";

export function approvalDeliveryKey(id: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `command-approval:${id}:${record.createdAt ?? 0}`;
}

export function approvalReplayTurn(request: Record<string, unknown>): Record<string, unknown> {
  const {
    surface: _surface,
    async: _async,
    idempotencyKey: _idempotencyKey,
    redeliveryKey: _redeliveryKey,
    approval: _approval,
    relayInput: _relayInput,
    intakePreambleMs: _intakePreambleMs,
    clientSentAt: _clientSentAt,
    ...turn
  } = request;
  return turn;
}

export function approvalDeliveryRecipient(actor: { externalId?: string } | undefined): string | undefined {
  const id = actor?.externalId;
  return id && !id.startsWith("system:") ? id : undefined;
}

function dmThreadTs(request: NonNullable<PendingApprovalRecord["request"]>): string | undefined {
  if (request.conversation?.kind !== "dm" || !request.deliveryTarget) return undefined;
  const [channel, threadTs] = request.deliveryTarget.split(":");
  return channel?.startsWith("D") && threadTs ? threadTs : undefined;
}

export function createApprovalStore(
  backing: DurableMap<PendingApprovalRecord>,
  deliveries: Pick<DeliveryStore, "enqueue">,
) {
  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    const request = record.request;
    if (!request || !isChatSurface(request.surface)) return;
    const actorId = approvalDeliveryRecipient(request.actor);
    if (!actorId) return;
    const threadTs = dmThreadTs(request);
    await deliveries.enqueue({
      destination: {
        ...principalDestination(actorId, actorId),
        commandApprovalId: id,
        ...(threadTs ? { threadTs } : {}),
        ...(request.slackSource
          ? { slackAccountId: request.slackSource.accountId, slackTeamId: request.slackSource.teamId }
          : {}),
      },
      text: `Approval needed: ${record.summary ?? record.command}`,
      idempotencyKey: approvalDeliveryKey(id, record),
    });
  }
  return {
    ...backing,
    async put(id: string, record: PendingApprovalRecord): Promise<void> {
      await backing.put(id, record);
      await deliver(id, record).catch(swallowAs("approvals: enqueue delivery", undefined));
    },
    async deliverPending(): Promise<void> {
      for (const [id, record] of await backing.entries()) await deliver(id, record);
    },
  };
}
