import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SpeechInput, type SpeechState } from "../src/speech.ts";

class Socket {
  static OPEN = 1;
  static latest: Socket;
  readyState = 1;
  bufferedAmount = 0;
  closed = false;
  frames: Record<string, any>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly url: URL;
  readonly protocols: string[];
  constructor(url: URL, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    Socket.latest = this;
    queueMicrotask(() => this.onopen?.());
  }
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  send(text: string) {
    const frame = JSON.parse(text);
    this.frames.push(frame);
    if (frame.type === "session.update") queueMicrotask(() => this.receive({ type: "session.updated" }));
  }
  close() {
    this.closed = true;
  }
}

class Capture {
  static latest: Capture;
  onprocessorerror: (() => void) | null = null;
  port = {
    onmessage: null as ((event: { data: ArrayBuffer | string }) => void) | null,
    postMessage: (message: string) => {
      if (message === "stop") queueMicrotask(() => this.port.onmessage?.({ data: "flushed" }));
    },
    close: () => {},
  };
  constructor() {
    Capture.latest = this;
  }
  connect() {}
  disconnect() {}
}

function fixture(t: TestContext, getUserMedia?: () => Promise<MediaStream>) {
  let stopped = 0;
  let contextClosed = 0;
  let configSignal: AbortSignal | undefined;
  const texts: string[] = [];
  const previews: string[] = [];
  const states: SpeechState[] = [];
  const errors: string[] = [];
  const track = { stop: () => stopped++, onended: null as (() => void) | null };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const replacements = {
    navigator: { mediaDevices: { getUserMedia: getUserMedia ?? (async () => stream) } },
    WebSocket: Socket,
    AudioWorkletNode: Capture,
    AudioContext: class {
      sampleRate = 24000;
      destination = {};
      audioWorklet = { addModule: async (url: string) => assert.equal(url, "/speech-worklet.js") };
      async resume() {}
      async close() {
        contextClosed++;
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
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
  const input = new SpeechInput({
    state: (state) => states.push(state),
    text: (text) => texts.push(text),
    preview: (text) => previews.push(text),
    error: (error) => errors.push(error),
    configure: async (signal) => {
      configSignal = signal;
      return { apiKey: "browser-test-key", model: "deepgram/nova-3", language: "en" };
    },
  });
  t.after(() => input.cancel());
  return {
    input,
    texts,
    previews,
    states,
    errors,
    stream,
    track,
    stopped: () => stopped,
    contextClosed: () => contextClosed,
    configSignal: () => configSignal,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("streams PCM directly using browser subprotocol auth, previews deltas and finishes once", async (t) => {
  const f = fixture(t);
  await f.input.start();
  const socket = Socket.latest;
  assert.equal(f.input.state, "recording");
  assert.equal(socket.url.origin, "wss://api.allmodels.io");
  assert.equal(socket.url.pathname, "/oai/realtime");
  assert.ok(!socket.url.toString().includes("browser-test-key"));
  assert.deepEqual(socket.protocols, ["realtime", "openai-insecure-api-key.browser-test-key"]);
  assert.equal(socket.frames[0].session.audio.input.turn_detection, null);
  Capture.latest.port.onmessage?.({ data: new Uint8Array([0, 0, 0xff, 0x7f]).buffer });
  assert.equal(socket.frames[1].type, "input_audio_buffer.append");
  assert.equal(socket.frames[1].audio, "AAD/fw==");
  socket.receive({ type: "conversation.item.input_audio_transcription.delta", item_id: "one", delta: "Add " });
  socket.receive({ type: "conversation.item.input_audio_transcription.delta", item_id: "one", delta: "speech" });
  assert.deepEqual(f.previews, ["Add ", "Add speech"]);
  assert.deepEqual(f.texts, []);
  f.input.stop();
  await tick();
  assert.equal(f.stopped(), 1);
  assert.equal(socket.frames.at(-1)?.type, "input_audio_buffer.commit");
  socket.receive({ type: "input_audio_buffer.committed", item_id: "one" });
  const completed = {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "one",
    transcript: " Add speech ",
  };
  socket.receive(completed);
  socket.receive(completed);
  assert.equal(f.input.state, "idle");
  assert.deepEqual(f.texts, ["Add speech"]);
  assert.deepEqual(f.errors, []);
  assert.equal(socket.closed, true);
  assert.equal(f.contextClosed(), 1);
  assert.deepEqual(f.states, ["starting", "recording", "transcribing", "idle"]);
});

test("cancel pending permission closes the late microphone without connecting", async (t) => {
  let grant!: (stream: MediaStream) => void;
  const pending = new Promise<MediaStream>((resolve) => {
    grant = resolve;
  });
  const f = fixture(t, () => pending);
  const start = f.input.start();
  await tick();
  f.input.cancel();
  grant(f.stream);
  await start;
  assert.equal(f.stopped(), 1);
  assert.equal(f.input.state, "idle");
  assert.equal(f.configSignal()?.aborted, true);
  assert.deepEqual(f.texts, []);
  assert.deepEqual(f.errors, []);
});

test("cancel ignores queued transcript callbacks and closes capture and socket", async (t) => {
  const f = fixture(t);
  await f.input.start();
  const late = Socket.latest.onmessage!;
  f.input.stop();
  f.input.cancel();
  late({
    data: JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "late",
      transcript: "stale",
    }),
  });
  await tick();
  assert.equal(f.input.state, "idle");
  assert.deepEqual(f.texts, []);
  assert.deepEqual(f.errors, []);
  assert.equal(Socket.latest.closed, true);
});

test("provider failures are sanitized and release the microphone", async (t) => {
  const f = fixture(t);
  await f.input.start();
  Socket.latest.receive({ type: "error", error: { message: "browser-test-key" } });
  assert.equal(f.input.state, "idle");
  assert.equal(f.stopped(), 1);
  assert.equal(f.errors.length, 1);
  assert.ok(!f.errors[0].includes("browser-test-key"));
});

test("backpressure closes a slow connection", async (t) => {
  const f = fixture(t);
  await f.input.start();
  Socket.latest.bufferedAmount = 512 * 1024 + 1;
  Capture.latest.port.onmessage?.({ data: new ArrayBuffer(4800) });
  assert.equal(f.input.state, "idle");
  assert.match(f.errors[0], /cannot keep up/);
});

test("completion arriving before commit acknowledgment still completes the stop", async (t) => {
  const f = fixture(t);
  await f.input.start();
  f.input.stop();
  await tick();
  Socket.latest.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "one",
    transcript: "Ready",
  });
  assert.equal(f.input.state, "transcribing");
  Socket.latest.receive({ type: "input_audio_buffer.committed", item_id: "one" });
  assert.equal(f.input.state, "idle");
  assert.deepEqual(f.texts, ["Ready"]);
});

test("microphone disconnect closes the session immediately", async (t) => {
  const f = fixture(t);
  await f.input.start();
  f.track.onended?.();
  assert.equal(f.input.state, "idle");
  assert.equal(Socket.latest.closed, true);
  assert.equal(f.contextClosed(), 1);
  assert.match(f.errors[0], /microphone disconnected/);
});
