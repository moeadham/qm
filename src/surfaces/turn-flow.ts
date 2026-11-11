import { swallow } from "../util/errors.ts";
import { sleep } from "../util/async.ts";
import type { SurfaceCoreClient, ToolCallView } from "./surface-core-client.ts";
import type { GoalView } from "../runs/turn-stream.ts";
import type { TurnRequest, TurnResult } from "../types.ts";
import { GENERIC_FAILURE_TEXT } from "../../plugins/chassis/src/failure-copy.ts";

class SurfaceTurnFailure extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

export function turnFailureText(err: unknown): string {
  return err instanceof SurfaceTurnFailure ? err.message : GENERIC_FAILURE_TEXT;
}

export function createInFlightThreadMap(): {
  set(threadRef: string, runId: string): void;
  get(threadRef: string): string | undefined;
  clear(threadRef: string, runId: string): void;
} {
  const byThread = new Map<string, string>();
  return {
    set: (threadRef, runId) => byThread.set(threadRef, runId),
    get: (threadRef) => byThread.get(threadRef),
    clear: (threadRef, runId) => {
      if (byThread.get(threadRef) === runId) byThread.delete(threadRef);
    },
  };
}

export function hasRunDelivery(result: TurnResult): boolean {
  return result.status === "ok" || result.status === "refused" || result.status === "failed";
}

export type CoreTurnBody = Omit<TurnRequest, "surface">;

interface TurnHooks {
  deferDeliveryAck?: boolean;
  onQueued?: (runId: string) => void | Promise<void>;
  onSteered?: (runId: string) => void | Promise<void>;
  onRunning?: () => void;
  onReplying?: () => void;
  onFirstBlock?: (text: string) => void;
  onSurfacePosted?: () => void;
  onGoal?: (goal: GoalView) => void;
  onSnapshot?: (text: string) => void;
  onToolCalls?: (calls: ToolCallView[]) => void;
}

export interface TurnFlow {
  callCore(body: CoreTurnBody, hooks?: TurnHooks): Promise<TurnResult>;
  inFlightRuns: { add(runId: string): void; delete(runId: string): void; has(runId: string): boolean };
  inFlightRunByThread: ReturnType<typeof createInFlightThreadMap>;
  ackRunDelivery(runId: string): void;
}

const ACK_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

export function createTurnFlow(
  core: Pick<SurfaceCoreClient, "submitTurn" | "waitRun" | "ackRunDelivery">,
  label = "surface",
): TurnFlow {
  const inFlightRunPins = new Map<string, number>();
  const inFlightRuns = {
    add: (runId: string): void => void inFlightRunPins.set(runId, (inFlightRunPins.get(runId) ?? 0) + 1),
    delete: (runId: string): void => {
      const held = inFlightRunPins.get(runId) ?? 0;
      if (held <= 1) inFlightRunPins.delete(runId);
      else inFlightRunPins.set(runId, held - 1);
    },
    has: (runId: string): boolean => inFlightRunPins.has(runId),
  };

  const inFlightRunByThread = createInFlightThreadMap();

  function ackRunDelivery(runId: string): void {
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await core.ackRunDelivery(runId);
          return;
        } catch (err) {
          if (attempt >= ACK_RETRY_DELAYS_MS.length) {
            console.error(
              `[${label}] delivery ack failed for run ${runId} (giving up — the poller re-delivers unacked runs):`,
              (err as Error).message,
            );
            return;
          }
          await sleep(ACK_RETRY_DELAYS_MS[attempt]!);
        }
      }
    })().finally(() => inFlightRuns.delete(runId));
  }

  function coreFailure(err: unknown): Error {
    swallow(`${label}: core call`, err);
    if ((err as { code?: string })?.code === "run_stalled") {
      return new SurfaceTurnFailure(
        "this request is taking unusually long — I'm still on it and will post the result here as soon as it finishes",
        err,
      );
    }
    return new SurfaceTurnFailure(GENERIC_FAILURE_TEXT, err);
  }

  async function callCore(body: CoreTurnBody, hooks: TurnHooks = {}): Promise<TurnResult> {
    let queued: TurnResult;
    try {
      queued = await core.submitTurn({ async: true, ...body });
    } catch (err) {
      throw coreFailure(err);
    }
    if (queued.status !== "queued" || !queued.runId) return queued;
    if (queued.steered) {
      await hooks.onSteered?.(queued.runId);
      return { status: "silent", steered: true };
    }
    inFlightRuns.add(queued.runId);
    try {
      await hooks.onQueued?.(queued.runId);
      return await pollRun(queued.runId, hooks);
    } finally {
      inFlightRuns.delete(queued.runId);
    }
  }

  async function pollRun(runId: string, hooks: TurnHooks): Promise<TurnResult> {
    inFlightRuns.add(runId);
    let result: TurnResult | null;
    try {
      result = await core.waitRun(runId, {
        ...(hooks.onRunning ? { onRunning: hooks.onRunning } : {}),
        ...(hooks.onReplying ? { onReplying: hooks.onReplying } : {}),
        ...(hooks.onFirstBlock ? { onFirstBlock: hooks.onFirstBlock } : {}),
        ...(hooks.onSurfacePosted ? { onSurfacePosted: hooks.onSurfacePosted } : {}),
        ...(hooks.onGoal ? { onGoal: hooks.onGoal } : {}),
        ...(hooks.onSnapshot ? { onSnapshot: hooks.onSnapshot } : {}),
        ...(hooks.onToolCalls ? { onToolCalls: hooks.onToolCalls } : {}),
      });
    } catch (err) {
      inFlightRuns.delete(runId);
      throw coreFailure(err);
    }
    if (result?.status === "refused" && result.refusalKind === "security_quarantine") {
      return result;
    }
    if (result && hasRunDelivery(result)) {
      if (!hooks.deferDeliveryAck) ackRunDelivery(runId);
    } else {
      inFlightRuns.delete(runId);
    }
    if (result) return result;
    throw new SurfaceTurnFailure("the agent finished without producing a reply", undefined);
  }

  return { callCore, inFlightRuns, inFlightRunByThread, ackRunDelivery };
}
