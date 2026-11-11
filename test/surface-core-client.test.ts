import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createErrorLog } from "../src/admin/error-log.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createTurnStream } from "../src/runs/turn-stream.ts";
import { createSurfaceCoreClient, type SurfaceCoreClientDeps } from "../src/surfaces/surface-core-client.ts";

test("waitRun reports each new reply snapshot once while the run streams, then returns the result", async () => {
  const stream = createTurnStream();
  stream.begin("r1");
  let polls = 0;
  const core = createSurfaceCoreClient("discord", {
    runs: {
      onTerminal() {},
      get: async () => {
        polls++;
        if (polls === 1) stream.publish("r1", "Hel");
        if (polls === 3) stream.publish("r1", "lo");
        return { id: "r1", status: polls < 5 ? "running" : "done", attempts: 1 };
      },
    },
    turnStream: stream,
    app: { getRun: async () => ({ result: { status: "ok", reply: "Hello" } }) },
  } as unknown as SurfaceCoreClientDeps);
  const seen: string[] = [];
  const result = await core.waitRun("r1", { onSnapshot: (text) => seen.push(text) });
  assert.deepEqual(seen, ["Hel", "Hello"]);
  assert.deepEqual(result, { status: "ok", reply: "Hello" });
  stream.end("r1");
});

test("expiring a delivery whose target is gone stops it being claimed and leaves an operator-visible error", async () => {
  const deliveries = createDeliveryStore();
  const errors = createErrorLog();
  const core = createSurfaceCoreClient("discord", {
    runs: { onTerminal() {} },
    deliveries,
    errors,
  } as unknown as SurfaceCoreClientDeps);
  const row = await deliveries.enqueue({
    destination: { type: "discord", target: "deleted-channel" },
    text: "hello",
    idempotencyKey: "gone",
  });
  await core.expireDelivery(row.id, "discord error 10003");
  assert.deepEqual(await deliveries.claimPending("discord", 60_000), []);
  const [event] = await errors.list();
  assert.equal(event?.code, "delivery_target_gone");
  assert.equal(event?.scopeLabel, "discord:deliveries");
  assert.ok(event?.message.includes(row.id) && event.message.includes("discord error 10003"), event?.message);
});

test("waitRun reports each new tool call once with its raw arguments", async () => {
  let polls = 0;
  const entries = [
    {
      seq: 3,
      type: "tool_call",
      payload: {
        tool: "bash",
        callId: "c1",
        step: { id: "s" },
        command: "ls -la",
        retrySafe: true,
        rerun: { tool: "bash", input: { command: "ls -la" } },
      },
    },
    { seq: 4, type: "tool_result", payload: { tool: "bash", callId: "c1", result: "ok" } },
    { seq: 5, type: "tool_call", payload: { tool: "read", callId: "c2", path: "README.md" } },
  ];
  const core = createSurfaceCoreClient("discord", {
    runs: {
      onTerminal() {},
      get: async () => {
        polls++;
        return { id: "r1", status: polls < 4 ? "running" : "done", attempts: 1 };
      },
    },
    turnStream: createTurnStream(),
    app: {
      getRun: async () => ({ result: { status: "ok", reply: "Done" } }),
      getRunToolEntries: async (_runId: string, _viewer: string | undefined, afterSeq?: number) =>
        entries.slice(0, polls === 1 ? 1 : 3).filter((e) => e.seq > (afterSeq ?? -1)),
    },
  } as unknown as SurfaceCoreClientDeps);
  const seen: unknown[] = [];
  await core.waitRun("r1", { onToolCalls: (calls) => seen.push(calls) });
  assert.deepEqual(seen, [
    [{ tool: "bash", args: { command: "ls -la" } }],
    [{ tool: "read", args: { path: "README.md" } }],
  ]);
});

test("waitRun signals once when a pending run starts running", async () => {
  const statuses = ["pending", "pending", "running", "running", "done"];
  let polls = 0;
  const core = createSurfaceCoreClient("discord", {
    runs: {
      onTerminal() {},
      get: async () => ({ id: "r1", status: statuses[Math.min(polls++, statuses.length - 1)], attempts: 1 }),
      activeForThread: async () => null,
    },
    turnStream: createTurnStream(),
    app: {
      getRun: async () => ({ result: { status: "ok", reply: "Done" } }),
      getRunToolEntries: async () => [],
    },
  } as unknown as SurfaceCoreClientDeps);
  const seen: string[] = [];
  await core.waitRun("r1", { onRunning: () => seen.push(`running after ${polls} polls`) });
  assert.deepEqual(seen, ["running after 3 polls"]);
});

function queuedBehind(ahead: () => { status: string; leaseExpiresAt: number } | null) {
  let status = "pending";
  const core = createSurfaceCoreClient("discord", {
    runs: {
      onTerminal() {},
      get: async () => ({ id: "r1", sessionId: "t1", status, attempts: 0 }),
      activeForThread: async () => {
        const run = ahead();
        return run
          ? { id: "r0", sessionId: "t1", attempts: 1, ...run }
          : { id: "r1", sessionId: "t1", status, attempts: 0 };
      },
    },
    turnStream: createTurnStream(),
    app: {
      getRun: async () => ({ result: { status: "ok", reply: "Done" } }),
      getRunToolEntries: async () => [],
    },
  } as unknown as SurfaceCoreClientDeps);
  return { core, finish: () => (status = "done") };
}

async function followFor(t: TestContext, seconds: number, waiting: Promise<unknown>): Promise<unknown> {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let failure: unknown;
  waiting.catch((error: unknown) => (failure = error));
  for (let second = 0; second < seconds && failure === undefined; second++) {
    await flush();
    t.mock.timers.tick(1_000);
  }
  await flush();
  return failure;
}

test("waitRun keeps following a queued run while the run ahead of it keeps working", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { core, finish } = queuedBehind(() => ({ status: "running", leaseExpiresAt: Date.now() + 30_000 }));
  const waiting = core.waitRun("r1");
  assert.equal(await followFor(t, 400, waiting), undefined);
  finish();
  t.mock.timers.tick(1_000);
  assert.deepEqual(await waiting, { status: "ok", reply: "Done" });
});

test("waitRun still gives up on a queued run that nothing ahead of it is moving", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { core } = queuedBehind(() => null);
  const failure = await followFor(t, 400, core.waitRun("r1"));
  assert.equal((failure as { code?: string } | undefined)?.code, "run_stalled");
});
