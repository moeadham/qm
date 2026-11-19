import assert from "node:assert/strict";
import test from "node:test";
import { createToolContext } from "../src/tools/primitives.ts";
import { SandboxRecoveredError, type Sandbox, type SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

test("a command that reports a recovered sandbox makes the turn provision that sandbox again", async () => {
  const handle: SandboxHandle = { id: "box", rootDir: "/workspace", resourceId: "res-1" };
  const invalidated: Array<{ id?: string; resourceId?: string } | undefined> = [];
  const ctx = createToolContext({
    sandbox: {
      async run() {
        throw new SandboxRecoveredError("QM: this computer stopped responding, so QM rebooted it.");
      },
    } as unknown as Sandbox,
    provision: async () => handle,
    invalidateProvision: (stale) => invalidated.push(stale),
    layers: [{ scopeId: scopeId("personal", "recovery-tester"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "recovery-tester",
  });

  await assert.rejects(ctx.execute("echo hi"), /QM rebooted it/);
  assert.deepEqual(
    invalidated.map((stale) => [stale?.id, stale?.resourceId]),
    [["box", "res-1"]],
  );
});
