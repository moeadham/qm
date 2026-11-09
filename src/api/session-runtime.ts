import type { AuditLog } from "../audit/audit-log.ts";
import type { RuntimeChoice } from "../harness/harness.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { Session } from "../types.ts";
import { availableRuntime, validateRuntimeChoice, type RuntimeDeps } from "./runtime-config.ts";

export async function setSessionRuntime(
  deps: {
    sessions: Pick<SessionStore, "setRuntime">;
    runtime: RuntimeDeps;
    auditLog?: Pick<AuditLog, "record">;
  },
  session: Session,
  principalId: string,
  choice: RuntimeChoice | null,
): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  let stored = choice;
  if (choice) {
    const invalid = validateRuntimeChoice(choice);
    if (invalid) return { ok: false, error: invalid };
    const available = await availableRuntime({ deps: deps.runtime }, session.scopeId, choice, undefined, principalId);
    if ("error" in available) return { ok: false, error: available.error };
    stored = available.choice;
  }
  await deps.sessions.setRuntime(session.id, stored);
  deps.auditLog?.record({
    at: Date.now(),
    principalId,
    action: "session-runtime.update",
    resource: session.id,
    scopeLabel: session.scopeId,
  });
  const { runtime: _previous, ...rest } = session;
  return { ok: true, session: stored ? { ...rest, runtime: stored } : rest };
}
