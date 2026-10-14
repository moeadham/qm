import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("worklet emits clipped little-endian PCM and flushes the final partial packet before acknowledgment", () => {
  let Capture!: new () => {
    process(inputs: Float32Array[][]): boolean;
    port: { onmessage: (event: { data: string }) => void };
  };
  const packets: (ArrayBuffer | string)[] = [];
  runInNewContext(readFileSync(new URL("../public/speech-worklet.js", import.meta.url), "utf8"), {
    AudioWorkletProcessor: class {
      port = { postMessage: (data: ArrayBuffer | string) => packets.push(data) };
    },
    registerProcessor: (name: string, processor: typeof Capture) => {
      assert.equal(name, "qm-speech-capture");
      Capture = processor;
    },
  });
  const capture = new Capture();
  capture.process([[new Float32Array([-2, -0.5, 0, 0.5, 2])]]);
  assert.equal(packets.length, 0);
  capture.port.onmessage({ data: "stop" });
  assert.equal(packets.length, 2);
  assert.equal(packets[1], "flushed");
  const view = new DataView(packets[0] as ArrayBuffer);
  assert.deepEqual(
    Array.from({ length: 5 }, (_, i) => view.getInt16(i * 2, true)),
    [-32768, -16384, 0, 16383, 32767],
  );
  assert.equal(capture.process([[new Float32Array(128)]]), false);
  assert.equal(packets.length, 2);
});
