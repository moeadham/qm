import assert from "node:assert/strict";
import test from "node:test";
import { SpeechInput, type SpeechState } from "../src/speech.ts";

class Recorder {
  static isTypeSupported(type: string) {
    return type.startsWith("audio/webm");
  }
  state = "inactive";
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  constructor(_stream: unknown, _options: unknown) {}
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(["recorded speech"]) });
      this.onstop?.();
    });
  }
}

test("record/stop releases the microphone and inserts an editable transcript once", async (t) => {
  let stopped = 0;
  const texts: string[] = [];
  const states: SpeechState[] = [];
  const errors: string[] = [];
  const stream = { getTracks: () => [{ stop: () => stopped++ }] } as unknown as MediaStream;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => stream } },
  });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder });
  t.after(() => {
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    if (oldRecorder) Object.defineProperty(globalThis, "MediaRecorder", oldRecorder);
    else Reflect.deleteProperty(globalThis, "MediaRecorder");
  });
  const input = new SpeechInput({
    state: (state) => states.push(state),
    text: (text) => texts.push(text),
    error: (error) => errors.push(error),
    transcribe: async (audio) => {
      assert.ok(audio.size);
      return { text: "  Add speech input  " };
    },
  });
  await input.start();
  assert.equal(input.state, "recording");
  input.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.state, "idle");
  assert.ok(stopped > 0);
  assert.deepEqual(texts, ["Add speech input"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(states, ["starting", "recording", "transcribing", "idle"]);
});

test("cancel while permission is pending closes the late stream without recording", async (t) => {
  let stopped = 0;
  let grant!: (stream: MediaStream) => void;
  const pending = new Promise<MediaStream>((resolve) => {
    grant = resolve;
  });
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: () => pending } },
  });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder });
  t.after(() => {
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    if (oldRecorder) Object.defineProperty(globalThis, "MediaRecorder", oldRecorder);
    else Reflect.deleteProperty(globalThis, "MediaRecorder");
  });
  const input = new SpeechInput({
    state: () => {},
    text: () => assert.fail("late transcript"),
    error: () => assert.fail("late error"),
    transcribe: async () => {
      assert.fail("unexpected transcription");
    },
  });
  const start = input.start();
  input.cancel();
  grant({ getTracks: () => [{ stop: () => stopped++ }] } as unknown as MediaStream);
  await start;
  assert.equal(stopped, 1);
  assert.equal(input.state, "idle");
});

test("cancel an in-flight transcription ignores a late result", async (t) => {
  let resolveTranscript!: (result: { text: string }) => void;
  let signal: AbortSignal | undefined;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) } },
  });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder });
  t.after(() => {
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    if (oldRecorder) Object.defineProperty(globalThis, "MediaRecorder", oldRecorder);
    else Reflect.deleteProperty(globalThis, "MediaRecorder");
  });
  const input = new SpeechInput({
    state: () => {},
    text: () => assert.fail("late transcript"),
    error: () => assert.fail("late error"),
    transcribe: (_audio, abort) => {
      signal = abort;
      return new Promise((resolve) => {
        resolveTranscript = resolve;
      });
    },
  });
  await input.start();
  input.stop();
  await new Promise((resolve) => setImmediate(resolve));
  input.cancel();
  assert.equal(signal?.aborted, true);
  resolveTranscript({ text: "stale" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.state, "idle");
});
