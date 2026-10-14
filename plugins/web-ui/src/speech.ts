import { UI_BASE } from "./deep-link.ts";

export type SpeechState = "idle" | "starting" | "recording" | "transcribing";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DURATION_MS = 120_000;

export interface SpeechConnection {
  apiKey: string;
  model: string;
  language?: string;
}

export interface SpeechCallbacks {
  state: (state: SpeechState) => void;
  text: (text: string) => void;
  preview: (text: string) => void;
  error: (message: string) => void;
  configure: (signal: AbortSignal) => Promise<SpeechConnection>;
}

export class SpeechInput {
  state: SpeechState = "idle";
  private version = 0;
  private stream?: MediaStream;
  private context?: AudioContext;
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private rejectStart?: (error: Error) => void;
  private bytes = 0;
  private committed?: string;
  private commitSent = false;
  private completed = new Set<string>();
  private previews = new Map<string, string>();
  private heardSpeech = false;

  private readonly callbacks: SpeechCallbacks;

  constructor(callbacks: SpeechCallbacks) {
    this.callbacks = callbacks;
  }

  private update(state: SpeechState): void {
    this.state = state;
    this.callbacks.state(state);
  }

  private fail(message: string): void {
    this.cancel();
    this.callbacks.error(message);
  }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    const version = ++this.version;
    this.bytes = 0;
    this.committed = undefined;
    this.commitSent = false;
    this.completed.clear();
    this.previews.clear();
    this.heardSpeech = false;
    this.controller = new AbortController();
    this.update("starting");
    this.timer = setTimeout(() => this.fail("Speech connection timed out. Try again."), 15_000);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
        this.fail("This browser does not support microphone input. Use HTTPS and a current browser.");
        return;
      }
      const settings = await this.callbacks.configure(this.controller.signal);
      if (version !== this.version) return;
      clearTimeout(this.timer);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (version !== this.version) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.timer = setTimeout(() => this.fail("Speech connection timed out. Try again."), 15_000);
      this.stream = stream;
      for (const track of stream.getTracks()) {
        track.onended = () => {
          if (version === this.version && (this.state === "starting" || this.state === "recording"))
            this.fail("The microphone disconnected. Try again.");
        };
      }
      const context = new AudioContext({ sampleRate: 24000 });
      this.context = context;
      if (context.sampleRate !== 24000 || !context.audioWorklet) {
        this.fail("This browser cannot stream the required microphone audio format.");
        return;
      }
      await context.resume();
      if (version !== this.version) return;
      await context.audioWorklet.addModule(`${UI_BASE}/speech-worklet.js`);
      if (version !== this.version) return;
      await this.connect(settings, version);
      if (version !== this.version) return;
      const capture = new AudioWorkletNode(context, "qm-speech-capture", {
        channelCount: 1,
        channelCountMode: "explicit",
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.capture = capture;
      capture.onprocessorerror = () => {
        if (version === this.version) this.fail("The microphone stopped working. Try again.");
      };
      capture.port.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        if (version !== this.version) return;
        if (event.data === "flushed") {
          this.commitSent = true;
          this.send({ type: "input_audio_buffer.commit" });
        } else if (event.data instanceof ArrayBuffer) {
          this.sendAudio(event.data);
        }
      };
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(capture);
      capture.connect(context.destination);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.stop(), MAX_DURATION_MS);
      this.update("recording");
    } catch (error) {
      if (version !== this.version) return;
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      this.fail(
        denied
          ? "Microphone access was denied. Allow it in your browser settings and try again."
          : "Could not start speech input. Check the connection, API key and STT model.",
      );
    }
  }

  private connect(settings: SpeechConnection, version: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.rejectStart = reject;
      const url = new URL("wss://api.allmodels.io/oai/realtime");
      url.searchParams.set("intent", "transcription");
      url.searchParams.set("model", settings.model);
      const socket = new WebSocket(url, ["realtime", `openai-insecure-api-key.${settings.apiKey}`]);
      this.socket = socket;
      socket.onopen = () => {
        if (version !== this.version) return;
        this.send({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: { model: settings.model, ...(settings.language ? { language: settings.language } : {}) },
                turn_detection: null,
              },
            },
          },
        });
      };
      socket.onmessage = (event) => {
        if (version !== this.version) return;
        try {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "session.updated") {
            this.rejectStart = undefined;
            resolve();
          }
          this.receive(frame);
        } catch {
          this.fail("AllModels returned an invalid speech response. Try again.");
        }
      };
      socket.onerror = () => {
        if (version === this.version) this.fail("Could not connect to AllModels speech input. Try again.");
      };
      socket.onclose = () => {
        if (version === this.version) this.fail("Speech connection closed before transcription finished. Try again.");
      };
    });
  }

  private send(frame: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private sendAudio(audio: ArrayBuffer): void {
    this.bytes += audio.byteLength;
    if (this.bytes > MAX_BYTES || (this.socket?.bufferedAmount ?? 0) > 512 * 1024) {
      this.fail("Speech connection cannot keep up. Try a shorter instruction.");
      return;
    }
    const bytes = new Uint8Array(audio);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    this.send({ type: "input_audio_buffer.append", audio: btoa(binary) });
  }

  private receive(frame: Record<string, unknown>): void {
    if (frame.type === "error" || frame.type === "conversation.item.input_audio_transcription.failed") {
      this.fail("AllModels could not transcribe this audio. Check the API key, balance and STT model.");
      return;
    }
    const item = typeof frame.item_id === "string" ? frame.item_id : undefined;
    if (!item) return;
    if (frame.type === "conversation.item.input_audio_transcription.delta" && typeof frame.delta === "string") {
      const text = (this.previews.get(item) ?? "") + frame.delta;
      this.previews.set(item, text);
      this.callbacks.preview(text.slice(-1000));
    }
    if (frame.type === "conversation.item.input_audio_transcription.completed") {
      if (!this.completed.has(item)) {
        this.completed.add(item);
        this.previews.delete(item);
        this.callbacks.preview("");
        const text = typeof frame.transcript === "string" ? frame.transcript.trim() : "";
        if (text) {
          this.heardSpeech = true;
          this.callbacks.text(text);
        }
      }
    }
    if (frame.type === "input_audio_buffer.committed" && this.commitSent) this.committed = item;
    if (this.state === "transcribing" && this.committed && this.completed.has(this.committed)) {
      const heardSpeech = this.heardSpeech;
      this.cancel();
      if (!heardSpeech) this.callbacks.error("No speech was detected. Try again.");
    }
  }

  stop(): void {
    if (this.state !== "recording") return;
    clearTimeout(this.timer);
    this.update("transcribing");
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.capture?.port.postMessage("stop");
    this.timer = setTimeout(() => this.fail("Transcription timed out. Try again."), 30_000);
  }

  cancel(): void {
    if (this.state === "idle") return;
    ++this.version;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = undefined;
    this.rejectStart?.(new Error("cancelled"));
    this.rejectStart = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.source?.disconnect();
    this.source = undefined;
    this.capture?.disconnect();
    this.capture?.port.close();
    this.capture = undefined;
    void this.context?.close().catch(() => undefined);
    this.context = undefined;
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.socket.close();
    }
    this.socket = undefined;
    this.previews.clear();
    this.completed.clear();
    this.update("idle");
  }
}
