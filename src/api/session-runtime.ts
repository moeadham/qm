import type { AuditLog } from "../audit/audit-log.ts";
import type { RuntimeChoice } from "../harness/harness.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { Session } from "../types.ts";
import { availableRuntimeError, validateRuntimeChoice, type RuntimeDeps } from "./runtime-config.ts";

export async function setSessionRuntime(
  deps: {
    sessions: Pick<SessionStore, "getForParticipant" | "setRuntime">;
    runtime: RuntimeDeps;
    auditLog?: Pick<AuditLog, "record">;
  },
  sessionId: string,
  principalId: string,
  choice: RuntimeChoice | null,
): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  const session = await deps.sessions.getForParticipant(sessionId, principalId);
  if (!session) return { ok: false, error: "not_found" };
  if (choice) {
    const error =
      validateRuntimeChoice(choice) ??
      (await availableRuntimeError({ deps: deps.runtime }, session.scopeId, choice, undefined, principalId));
    if (error) return { ok: false, error };
  }
  await deps.sessions.setRuntime(session.id, choice);
  deps.auditLog?.record({
    at: Date.now(),
    principalId,
    action: "session-runtime.update",
    resource: session.id,
    scopeLabel: session.scopeId,
  });
  const { runtime: _previous, ...rest } = session;
  return { ok: true, session: choice ? { ...rest, runtime: choice } : rest };
}
