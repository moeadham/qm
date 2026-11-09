import { test } from "node:test";
import assert from "node:assert/strict";
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
