import type { SessionRuntime } from "../types.ts";
function sameRuntime(a: SessionRuntime | undefined, b: SessionRuntime | undefined): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.harnessId === b.harnessId &&
    a.modelId === b.modelId &&
    a.effortLevel === b.effortLevel &&
    a.fastMode === b.fastMode
  );
}

export async function resolveTurnRuntime(
  deps: {
    pin(runtime: SessionRuntime | null): Promise<{ ok: true; runtime?: SessionRuntime } | { ok: false; error: string }>;
    problem(runtime: SessionRuntime): Promise<string | null>;
  },
  saved: SessionRuntime | undefined,
  request: { pinRuntime?: boolean; harness?: string; model?: string; thinkingLevel?: string; fastMode?: boolean },
): Promise<{ runtime?: SessionRuntime; problem?: string }> {
  let current = saved;
  if (request.pinRuntime !== undefined) {
    const pinned =
      request.pinRuntime && request.model && request.harness
        ? {
            harnessId: request.harness,
            modelId: request.model,
            ...(request.thinkingLevel ? { effortLevel: request.thinkingLevel } : {}),
            ...(typeof request.fastMode === "boolean" ? { fastMode: request.fastMode } : {}),
          }
        : undefined;
    if (!sameRuntime(pinned, current)) {
      const out = await deps.pin(pinned ?? null);
      if (!out.ok) return { problem: `pin rejected: ${out.error}` };
      current = out.runtime;
    }
  }
  if (request.model || request.harness || !current) return {};
  const problem = await deps.problem(current);
  return problem ? { problem } : { runtime: current };
}
