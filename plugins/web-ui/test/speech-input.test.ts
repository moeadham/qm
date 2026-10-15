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
      return { apiKey: "browser-test-key", model: "assemblyai/universal-3-5-pro-realtime", language: "en" };
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
  assert.deepEqual(socket.frames[0].session.audio.input.turn_detection, {
    type: "server_vad",
    silence_duration_ms: 700,
  });
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
  socket.onclose?.();
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
  Capture.latest.port.onmessage?.({ data: new Uint8Array([0, 0x40]).buffer });
  f.input.stop();
  await tick();
  Socket.latest.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "one",
    transcript: "Ready",
  });
  assert.equal(f.input.state, "transcribing");
  Socket.latest.receive({ type: "input_audio_buffer.committed", item_id: "one" });
  Socket.latest.onclose?.();
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

test("an explicitly selected microphone is used and may be changed during recording", async (t) => {
  const constraints: MediaStreamConstraints[] = [];
  const streams: { stopped: number; onended: (() => void) | null }[] = [];
  const f = fixture(t);
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    value: async (options: MediaStreamConstraints) => {
      constraints.push(options);
      const track = {
        stopped: 0,
        onended: null as (() => void) | null,
        stop() {
          this.stopped++;
        },
      };
      streams.push(track);
      return { getTracks: () => [track] };
    },
  });
  await f.input.selectMicrophone("usb-mic");
  await f.input.start();
  assert.deepEqual((constraints[0].audio as MediaTrackConstraints).deviceId, { exact: "usb-mic" });
  await f.input.selectMicrophone("headset");
  assert.deepEqual((constraints[1].audio as MediaTrackConstraints).deviceId, { exact: "headset" });
  assert.equal(streams[0].stopped, 1);
  assert.equal(f.input.selectedMicrophone, "headset");
  assert.equal(f.input.state, "recording");
  f.input.cancel();
  assert.equal(streams[1].stopped, 1);
});

test("an unavailable saved microphone falls back to the default input", async (t) => {
  const f = fixture(t);
  const constraints: MediaStreamConstraints[] = [];
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    value: async (options: MediaStreamConstraints) => {
      constraints.push(options);
      if (constraints.length === 1) throw new DOMException("Device unavailable", "OverconstrainedError");
      return f.stream;
    },
  });
  await f.input.selectMicrophone("unplugged-mic");
  await f.input.start();
  assert.deepEqual((constraints[0].audio as MediaTrackConstraints).deviceId, { exact: "unplugged-mic" });
  assert.equal((constraints[1].audio as MediaTrackConstraints).deviceId, undefined);
  assert.equal(f.input.selectedMicrophone, "");
  assert.equal(f.input.state, "recording");
  assert.deepEqual(f.errors, []);
});

test("silent input ends with a microphone hint rather than a transcription timeout", async (t) => {
  const f = fixture(t);
  await f.input.start();
  Capture.latest.port.onmessage?.({ data: new ArrayBuffer(4800) });
  f.input.stop();
  await tick();
  assert.equal(f.input.state, "idle");
  assert.match(f.errors[0], /No microphone audio detected/);
  assert.ok(!Socket.latest.frames.some((frame) => frame.type === "input_audio_buffer.commit"));
});

test("Stop sends a close control to flush a provider that does not finalize the commit", async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await f.input.start();
  Capture.latest.port.onmessage?.({ data: new Uint8Array([0, 0x40]).buffer });
  Socket.latest.receive({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "one",
    delta: "Keep these words",
  });
  f.input.stop();
  await tick();
  t.mock.timers.tick(1500);
  assert.equal(Socket.latest.frames.at(-1)?.type, "close");
  Socket.latest.onclose?.();
  assert.equal(f.input.state, "idle");
  assert.deepEqual(f.texts, ["Keep these words"]);
  assert.deepEqual(f.errors, []);
});

test("missing audio packets release the microphone promptly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = fixture(t);
  await f.input.start();
  t.mock.timers.tick(6000);
  assert.equal(f.input.state, "idle");
  assert.match(f.errors[0], /No audio is arriving/);
  assert.equal(Socket.latest.closed, true);
});

test("device discovery filters outputs and duplicate default entries", async (t) => {
  const f = fixture(t);
  Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
    value: async () => [
      { kind: "audioinput", deviceId: "default", label: "Default" },
      { kind: "audiooutput", deviceId: "speaker", label: "Speaker" },
      { kind: "audioinput", deviceId: "usb", label: "USB microphone" },
      { kind: "audioinput", deviceId: "usb", label: "Duplicate" },
    ],
  });
  await f.input.refreshMicrophones();
  assert.deepEqual(f.input.microphones, [{ deviceId: "usb", label: "USB microphone" }]);
});

test("a microphone permission result arriving after Stop is immediately released", async (t) => {
  const f = fixture(t);
  await f.input.start();
  let grant!: (stream: MediaStream) => void;
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    value: () =>
      new Promise<MediaStream>((resolve) => {
        grant = resolve;
      }),
  });
  const switching = f.input.selectMicrophone("late");
  Capture.latest.port.onmessage?.({ data: new Uint8Array([0, 0x40]).buffer });
  f.input.stop();
  let released = 0;
  grant({ getTracks: () => [{ stop: () => released++ }] } as unknown as MediaStream);
  await switching;
  assert.equal(released, 1);
  assert.equal(f.input.selectedMicrophone, "");
  assert.equal(f.input.state, "transcribing");
});

test("an uninstalled replacement microphone is released when graph setup fails", async (t) => {
  const f = fixture(t);
  await f.input.start();
  let released = 0;
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    value: async () => ({ getTracks: () => [{ stop: () => released++ }] }),
  });
  const Context = globalThis.AudioContext;
  Object.defineProperty(Context.prototype, "createMediaStreamSource", {
    value: () => {
      throw new Error("graph failed");
    },
  });
  await f.input.selectMicrophone("failed");
  assert.equal(released, 1);
  assert.equal(f.input.state, "recording");
  assert.equal(f.input.selectedMicrophone, "");
  assert.match(f.errors[0], /Could not open that microphone/);
});

test("the microphone preference survives a new controller", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const first = fixture(t);
  await first.input.selectMicrophone("remembered-mic");
  const second = new SpeechInput({
    state: () => {},
    text: () => {},
    preview: () => {},
    error: () => {},
    configure: async () => ({ apiKey: "test", model: "assemblyai/universal-3-5-pro-realtime" }),
  });
  assert.equal(second.selectedMicrophone, "remembered-mic");
  await second.selectMicrophone("");
  assert.equal(values.has("qm.speech.microphone"), false);
});

test("stop waits for final text and returns one shared completion result", async (t) => {
  const f = fixture(t);
  await f.input.start();
  Capture.latest.port.onmessage?.({ data: new Uint8Array([0xff, 0x7f]).buffer });
  const result = f.input.stop();
  assert.equal(f.input.stop(), result);
  let resolved = false;
  void result.then(() => {
    resolved = true;
  });
  await tick();
  assert.equal(resolved, false);
  Socket.latest.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "final",
    transcript: "Finalized instruction.",
  });
  Socket.latest.onclose?.();
  assert.equal(await result, true);
  assert.deepEqual(f.texts, ["Finalized instruction."]);
  assert.equal(f.input.state, "idle");
});

test("cancel and provider errors abort pending transcription completion", async (t) => {
  const f = fixture(t);
  await f.input.start();
  const cancelled = f.input.stop();
  f.input.cancel();
  assert.equal(await cancelled, false);
  await f.input.start();
  const failed = f.input.stop();
  Socket.latest.receive({ type: "error", error: { message: "provider failed" } });
  assert.equal(await failed, false);
  assert.equal(await f.input.stop(), false);
});

test("healthy streaming continues beyond the former duration and audio-size limits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  await f.input.start();
  t.mock.timers.tick(180_000);
  assert.equal(f.input.state, "recording");
  const audio = new Uint8Array(4800).buffer;
  for (let i = 0; i < 1800; i++) Capture.latest.port.onmessage?.({ data: audio });
  assert.equal(f.input.state, "recording");
  assert.equal(Socket.latest.frames.filter((frame) => frame.type === "input_audio_buffer.append").length, 1800);
  assert.deepEqual(f.errors, []);
});

test("unexpected connection loss keeps partial words without completing a pending send", async (t) => {
  const f = fixture(t);
  await f.input.start();
  Socket.latest.receive({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "partial",
    delta: "Keep the last words",
  });
  const result = f.input.stop();
  Socket.latest.onerror?.();
  assert.equal(await result, false);
  assert.equal(f.input.state, "idle");
  assert.deepEqual(f.texts, ["Keep the last words"]);
  assert.equal(f.previews.at(-1), "");
  assert.equal(f.errors.length, 1);
});
