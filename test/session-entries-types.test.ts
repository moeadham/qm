import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";

for (const backend of ["memory", "postgres"] as const) {
  test(
    `getEntries returns only the requested entry types: ${backend}`,
    { skip: backend === "postgres" && !process.env.DATABASE_URL },
    async () => {
      const store =
        backend === "memory" ? createMemorySessionStore() : createPostgresSessionStore(process.env.DATABASE_URL!);
      const scope = scopeId("personal", "types-test");
      const session = await store.getOrCreateByThread(`web:types-test:${randomUUID()}`, "dm", scope);
      const { lease } = await store.acquireLease(session.id);
      assert.ok(lease);
      await store.appendMany(lease, [
        { type: "user", payload: { text: "go" }, scopeLabel: scope },
        { type: "tool_call", payload: { tool: "bash", callId: "c1" }, scopeLabel: scope },
        { type: "assistant", payload: { text: "thinking out loud" }, scopeLabel: scope },
        { type: "tool_result", payload: { tool: "bash", callId: "c1" }, scopeLabel: scope },
      ]);
      const entries = await store.getEntries(session.id, { sinceSeq: 1, types: ["tool_call", "tool_result"] });
      assert.deepEqual(
        entries.map((e) => e.type),
        ["tool_call", "tool_result"],
      );
    },
  );
}
