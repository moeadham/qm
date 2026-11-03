import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { App } from "../api/app.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import type { MetricsSink } from "../admin/metrics-sink.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { MAX_BLOB_BYTES } from "../persistence/blob-transfer.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import type { RunStore } from "../runs/run-store.ts";
import { isTerminal } from "../runs/run-store.ts";
import type { GoalView, TurnStream } from "../runs/turn-stream.ts";
import type { Delivery, ScopeId, TurnRequest, TurnResult } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import type { StagedEnvelope } from "./envelope-staging.ts";

export interface RunHooks {
  onReplying?(): void;
  onFirstBlock?(text: string): void;
  onSurfacePosted?(): void;
  onGoal?(goal: GoalView): void | Promise<void>;
  onSnapshot?(text: string): void;
}

export interface SurfaceCoreClient {
  stageBlob(bytes: Uint8Array): Promise<{ blobId: string; sizeBytes: number }>;
  readBlob(blobId: string): Promise<Buffer>;
  submitTurn(body: Omit<TurnRequest, "surface">): Promise<TurnResult>;
  waitRun(runId: string, hooks?: RunHooks): Promise<TurnResult | null>;
  activeRunForThread(threadRef: string): Promise<string | undefined>;
  signalRunAbort(runId: string): Promise<void>;
  stopConversation(threadRef: string): Promise<boolean>;
  ackRunDelivery(runId: string): Promise<void>;
  reportTurnMetrics(runId: string, patch: { deliverMs?: number; slackInflightMs?: number }): Promise<void>;
  reportRunEditRef(runId: string, editRef: string): Promise<void>;
  claimDeliveries(type: string, claimMs: number): Promise<Delivery[]>;
  ackDelivery(id: string, body?: { recipientThreadRef?: string; slackApiMs?: number }): Promise<void>;
  reportSlowDeliveryDrain?(info: { durationMs: number; rows: number }): Promise<void>;
  reportDeliveryUndeliverable?(id: string, reason: string): Promise<void>;
  onDeliveryEnqueued(listener: () => void): () => void;
  holdLease<T>(name: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  stagedEnvelopes?: DurableMap<StagedEnvelope>;
}

export interface SurfaceCoreClientDeps {
  app: App;
  blobTransfer: BlobTransferStore;
  deliveries: DeliveryStore;
  errors?: ErrorLog;
  metrics: MetricsSink;
  runs: RunStore;
  turnStream: TurnStream;
  leaderLease?: LeaderLease;
  stagedEnvelopes?: DurableMap<StagedEnvelope>;
}

const RUN_FALLBACK_POLL_MS = 1_000;
const RUN_STALL_BUDGET_MS = 300_000;

export function createSurfaceCoreClient(surface: string, deps: SurfaceCoreClientDeps): SurfaceCoreClient {
  const lease = deps.leaderLease ?? createNoopLeaderLease();
  const deliveryScope = `${surface}:deliveries` as ScopeId;
  const terminalWaiters = new Map<string, Set<() => void>>();
  deps.runs.onTerminal((run) => {
    for (const wake of terminalWaiters.get(run.id) ?? []) wake();
  });

  return {
    async stageBlob(bytes) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const info = await deps.blobTransfer.put(Readable.from([Buffer.from(bytes)]), {
        maxBytes: MAX_BLOB_BYTES,
        expectedSha256: sha256,
      });
      return { blobId: info.blobId, sizeBytes: info.sizeBytes };
    },

    async readBlob(blobId) {
      const blob = await deps.blobTransfer.open(blobId);
      if (!blob) throw new Error(`blob ${blobId} not found`);
      return buffer(blob.stream);
    },

    submitTurn(body) {
      return deps.app.turn({ ...body, surface });
    },

    async waitRun(runId, hooks = {}) {
      let replyingSignaled = false;
      let firstBlockSignaled = false;
      let surfaceSignaled = false;
      let lastSnapshot = "";
      const signalReplying = (durable = false): void => {
        if (replyingSignaled || !(durable || deps.turnStream.replying(runId))) return;
        replyingSignaled = true;
        hooks.onReplying?.();
      };
      const signalFirstBlock = (text: string): void => {
        if (firstBlockSignaled || !text.trim()) return;
        firstBlockSignaled = true;
        hooks.onFirstBlock?.(text);
      };
      const signalSurface = (): void => {
        if (surfaceSignaled) return;
        surfaceSignaled = true;
        hooks.onSurfacePosted?.();
      };
      const signalSnapshot = (): void => {
        if (!hooks.onSnapshot) return;
        const text = deps.turnStream.snapshot(runId) ?? "";
        if (!text.trim() || text === lastSnapshot) return;
        lastSnapshot = text;
        hooks.onSnapshot(text);
      };
      const waiters = terminalWaiters.get(runId) ?? new Set();
      terminalWaiters.set(runId, waiters);
      const unsubscribe = deps.turnStream.subscribe(runId, {
        onFirstBlock: signalFirstBlock,
        onSurfacePosted: signalSurface,
      });
      let lastProgressAt = Date.now();
      let lastMark = "";
      let goalSnapshot = "";
      const emitGoal = async (): Promise<void> => {
        if (!hooks.onGoal) return;
        const goal = deps.turnStream.goal(runId);
        if (!goal) return;
        const next = JSON.stringify(goal);
        if (next === goalSnapshot) return;
        goalSnapshot = next;
        await hooks.onGoal(goal);
      };
      try {
        for (;;) {
          let run;
          try {
            run = await deps.runs.get(runId);
          } catch (err) {
            if (Date.now() - lastProgressAt >= RUN_STALL_BUDGET_MS) throw err;
            run = undefined;
          }
          if (run !== undefined) {
            if (!run) throw new Error(`run ${runId} not found`);
            if (deps.turnStream.surfacePosted(runId)) signalSurface();
            if (isTerminal(run.status)) {
              const view = await deps.app.getRun(runId);
              await emitGoal().catch(swallowAs(`${surface}: terminal goal refresh`, undefined));
              if (view?.surfacePosted) signalSurface();
              return (view?.result as TurnResult | null | undefined) ?? null;
            }
            signalReplying(run.deliveryState?.replying === true);
            signalSnapshot();
            await emitGoal().catch(swallowAs(`${surface}: goal refresh`, undefined));
            const fb = deps.turnStream.firstBlock(runId);
            if (fb?.closed) signalFirstBlock(fb.text);
            const mark = `${run.status}:${run.attempts}:${run.leaseExpiresAt ?? ""}`;
            if (mark !== lastMark) {
              lastMark = mark;
              lastProgressAt = Date.now();
            }
            if (Date.now() - lastProgressAt >= RUN_STALL_BUDGET_MS) {
              throw Object.assign(
                new Error(`run ${runId} made no progress for ${Math.round(RUN_STALL_BUDGET_MS / 1000)}s — giving up`),
                { code: "run_stalled" },
              );
            }
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, RUN_FALLBACK_POLL_MS);
            function done(): void {
              clearTimeout(timer);
              waiters.delete(done);
              resolve();
            }
            waiters.add(done);
          });
        }
      } finally {
        unsubscribe();
        if (waiters.size === 0) terminalWaiters.delete(runId);
      }
    },

    async activeRunForThread(threadRef) {
      return (await deps.app.activeRunForThread(threadRef))?.runId;
    },

    stopConversation(threadRef) {
      return deps.app.stopConversation(threadRef);
    },

    async signalRunAbort(runId) {
      const outcome = await deps.app.signalRun(runId, { kind: "abort" });
      if (!outcome.accepted) throw new Error(`signal abort not accepted: ${outcome.reason ?? "unknown"}`);
    },

    async ackRunDelivery(runId) {
      await deps.app.ackDeliveryByKey(`run:${runId}`);
    },

    async reportTurnMetrics(runId, patch) {
      await deps.metrics.updateByRunId(runId, patch);
    },

    async reportRunEditRef(runId, editRef) {
      const found = await deps.app.setRunDeliveryState(runId, { editRef });
      if (!found) throw new Error(`run ${runId} not found`);
    },

    claimDeliveries(type, claimMs) {
      return deps.app.pendingDeliveries(type, claimMs);
    },

    async ackDelivery(id, body) {
      if (body?.recipientThreadRef) await deps.app.recordPrincipalDelivery(id, body.recipientThreadRef);
      await deps.app.ackDelivery(id, body?.slackApiMs);
    },

    async reportDeliveryUndeliverable(id, reason) {
      deps.errors?.record({
        category: "delivery",
        code: "delivery_undeliverable",
        message: `delivery ${id} cannot be delivered (${reason}) — retrying until the TTL expires it`,
        scopeLabel: deliveryScope,
      });
    },

    async reportSlowDeliveryDrain(info) {
      deps.errors?.record({
        category: "delivery",
        code: "delivery_drain_slow",
        message: `drain cycle took ${Math.round(info.durationMs / 1000)}s for ${info.rows} rows`,
        scopeLabel: deliveryScope,
      });
    },

    onDeliveryEnqueued(listener) {
      return deps.deliveries.onEnqueue(listener);
    },

    holdLease(name, fn) {
      return lease.hold(`${surface}:${name}`, fn);
    },

    ...(deps.stagedEnvelopes ? { stagedEnvelopes: deps.stagedEnvelopes } : {}),
  };
}
