import assert from "node:assert/strict";
import test from "node:test";
import { SpeechWaveform } from "../src/speech-waveform.ts";

test("new microphone amplitude enters at the right and older samples scroll left", (t) => {
  const bars: number[][] = [];
  let resize!: () => void;
  let disconnected = 0;
  const motion = { matches: false, addEventListener() {}, removeEventListener() {} };
  const context = {
    setTransform() {},
    clearRect() {
      bars.length = 0;
    },
    fillRect: (...rect: number[]) => bars.push(rect),
    fillStyle: "",
    globalAlpha: 1,
  };
  const canvas = { clientWidth: 16, clientHeight: 30, width: 0, height: 0, getContext: () => context };
  const replacements = {
    window: { devicePixelRatio: 2, matchMedia: () => motion },
    getComputedStyle: () => ({ color: "gray" }),
    ResizeObserver: class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {
        disconnected++;
      }
    },
  };
  for (const [name, value] of Object.entries(replacements)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const waveform = new SpeechWaveform();
  waveform.attach(canvas as unknown as Element);
  waveform.push(0.25);
  assert.equal(canvas.width, 32);
  assert.equal(canvas.height, 60);
  assert.equal(bars.at(-1)?.[0], 24);
  const firstHeight = bars.at(-1)![3];
  waveform.push(0.8);
  assert.equal(bars.at(-2)?.[0], 16);
  assert.equal(bars.at(-2)?.[3], firstHeight);
  assert.ok(bars.at(-1)![3] > firstHeight);
  canvas.clientWidth = 24;
  resize();
  assert.equal(bars.length, 6);
  assert.equal(bars.at(-2)?.[3], firstHeight);
  motion.matches = true;
  waveform.push(0.4);
  assert.equal(new Set(bars.map((bar) => bar[3])).size, 1);
  waveform.reset();
  assert.ok(bars.every((bar) => bar[3] === 3));
  waveform.dispose();
  assert.equal(disconnected, 1);
});
