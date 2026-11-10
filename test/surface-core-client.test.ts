import { test } from "node:test";
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
