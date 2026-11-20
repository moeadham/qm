import assert from "node:assert/strict";
import test from "node:test";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { SandboxRecoveredError, type Sandbox, type SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

const handle: SandboxHandle = { id: "box", rootDir: "/workspace", resourceId: "res-1" };

function resetContext(extra: Partial<ToolContextDeps> = {}) {
  const invalidated: Array<{ id?: string; resourceId?: string } | undefined> = [];
  const ctx = createToolContext({
    sandbox: {
      profile: { backend: "sprites" },
      computerStatus: async () => ({ machine: "healthy", provisioned: true, guestResponsive: true }),
      async run() {
        throw new SandboxRecoveredError("QM: this computer's workspace is missing.");
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
    ...extra,
  });
  const dropped = () => invalidated.map((stale) => [stale?.id, stale?.resourceId]);
  return { ctx, dropped };
}

test("a command that finds its sandbox reset makes the turn provision that sandbox again", async () => {
  const { ctx, dropped } = resetContext();
  await assert.rejects(ctx.execute("echo hi"), /workspace is missing/);
  assert.deepEqual(dropped(), [["box", "res-1"]]);
});

test("a reset found while staging file credentials also drops the stale sandbox", async () => {
  const { ctx, dropped } = resetContext({
    commandCredentials: [
      {
        handle: "key",
        async resolve() {
          return {
            env: [],
            files: {
              files: [{ path: "~/.config/tool/key", contentBase64: Buffer.from("k").toString("base64") }],
              async save() {},
            },
            async commit() {},
          };
        },
      },
    ],
  });
  await assert.rejects(ctx.execute("echo hi", { credentials: ["key"] }), /workspace is missing/);
  assert.deepEqual(dropped(), [["box", "res-1"]]);
});

test("a status check that finds the sandbox reset drops it so the next command provisions again", async () => {
  const { ctx, dropped } = resetContext();
  const status = await ctx.computerStatus();
  assert.equal(status.guestResponsive, false);
  assert.deepEqual(dropped(), [["box", "res-1"]]);
});
