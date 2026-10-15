import { UI_BASE } from "./deep-link.ts";

export type SpeechState = "idle" | "starting" | "recording" | "transcribing";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DURATION_MS = 120_000;

export interface SpeechConnection {
  apiKey: string;
  model: string;
  language?: string;
}

export interface SpeechMicrophone {
  deviceId: string;
  label: string;
}

export interface SpeechCallbacks {
  changed?: () => void;
  state: (state: SpeechState) => void;
  text: (text: string) => void;
  preview: (text: string) => void;
  error: (message: string) => void;
  configure: (signal: AbortSignal) => Promise<SpeechConnection>;
}

export class SpeechInput {
  state: SpeechState = "idle";
  microphones: SpeechMicrophone[] = [];
  selectedMicrophone = "";
  switchingMicrophone = false;
  level = 0;
  private deviceVersion = 0;
  private packets = 0;
  private events = 0;
  private audible = false;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private captureTimer?: ReturnType<typeof setTimeout>;
  private lastAudioAt = 0;
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
  private closeSent = false;
  private commitSent = false;
  private completed = new Set<string>();
  private previews = new Map<string, string>();
  private heardSpeech = false;

  private readonly callbacks: SpeechCallbacks;

  constructor(callbacks: SpeechCallbacks) {
    this.callbacks = callbacks;
    try {
      this.selectedMicrophone =
        typeof window === "undefined" ? "" : (window.localStorage.getItem("qm.speech.microphone") ?? "");
    } catch {
      this.selectedMicrophone = "";
    }
  }

  async refreshMicrophones(requestAccess = false): Promise<void> {
    const version = ++this.deviceVersion;
    let permissionStream: MediaStream | undefined;
    try {
      if (requestAccess) permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const devices = await navigator.mediaDevices?.enumerateDevices?.();
      if (version !== this.deviceVersion || !devices) return;
      const seen = new Set(["", "default"]);
      this.microphones = devices
        .filter((device) => {
          if (device.kind !== "audioinput" || seen.has(device.deviceId)) return false;
          seen.add(device.deviceId);
          return true;
        })
        .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }));
      this.callbacks.changed?.();
    } catch {
      if (requestAccess && version === this.deviceVersion)
        this.callbacks.error("Could not list microphones. Allow microphone access in your browser settings.");
    } finally {
      permissionStream?.getTracks().forEach((track) => track.stop());
    }
  }

  async selectMicrophone(deviceId: string): Promise<void> {
    if (this.state === "starting" || this.state === "transcribing" || this.switchingMicrophone) return;
    const version = this.version;
    this.switchingMicrophone = true;
    this.callbacks.changed?.();
    let pendingStream: MediaStream | undefined;
    try {
      if (this.state === "recording") {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: this.constraints(deviceId) });
        pendingStream = stream;
        if (version !== this.version || this.state !== "recording") return;
        const source = this.context!.createMediaStreamSource(stream);
        source.connect(this.capture!);
        this.source?.disconnect();
        this.stream?.getTracks().forEach((track) => {
          track.onended = null;
          track.stop();
        });
        this.source = source;
        this.stream = stream;
        pendingStream = undefined;
        this.watchTracks(stream, version);
      }
      this.selectedMicrophone = deviceId;
      try {
        if (typeof window !== "undefined") {
          if (deviceId) window.localStorage.setItem("qm.speech.microphone", deviceId);
          else window.localStorage.removeItem("qm.speech.microphone");
        }
      } catch {
        this.callbacks.changed?.();
      }
    } catch {
      if (version === this.version) this.callbacks.error("Could not open that microphone. Select another input.");
    } finally {
      pendingStream?.getTracks().forEach((track) => track.stop());
      this.switchingMicrophone = false;
      this.callbacks.changed?.();
    }
  }

  private constraints(deviceId = this.selectedMicrophone): MediaTrackConstraints {
    return {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };
  }

  private watchTracks(stream: MediaStream, version: number): void {
    for (const track of stream.getTracks())
      track.onended = () => {
        if (version === this.version && (this.state === "starting" || this.state === "recording"))
          this.fail("The microphone disconnected. Select another input and try again.");
      };
  }

  private diagnostic(reason: string): void {
    console.debug(
      "[qm-speech]",
      JSON.stringify({
        reason,
        packets: this.packets,
        bytes: this.bytes,
        receivedEvents: this.events,
        audibleInput: this.audible,
        audioContext: this.context?.state,
      }),
    );
  }

  private update(state: SpeechState): void {
    this.state = state;
    this.callbacks.state(state);
  }

  private fail(message: string): void {
    this.diagnostic(message);
    this.cancel();
    this.callbacks.error(message);
  }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    const version = ++this.version;
    this.bytes = 0;
    this.packets = 0;
    this.events = 0;
    this.audible = false;
    this.level = 0;
    this.closeSent = false;
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
        audio: this.constraints(),
      });
      if (version !== this.version) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.timer = setTimeout(() => this.fail("Speech connection timed out. Try again."), 15_000);
      this.stream = stream;
      this.watchTracks(stream, version);
      void this.refreshMicrophones();
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
          if ((!this.bytes || !this.audible) && !this.heardSpeech && !this.previews.size) {
            this.fail("No microphone audio detected. Check the input meter and select the correct microphone.");
            return;
          }
          this.send({ type: "input_audio_buffer.commit" });
          this.closeTimer = setTimeout(() => this.closeStream(), 1500);
        } else if (event.data instanceof ArrayBuffer) {
          this.sendAudio(event.data);
        }
      };
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(capture);
      capture.connect(context.destination);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.stop(), MAX_DURATION_MS);
      this.lastAudioAt = Date.now();
      this.captureTimer = setInterval(() => {
        if (Date.now() - this.lastAudioAt > 5000)
          this.fail("No audio is arriving from the microphone. Check microphone access and the selected input.");
      }, 1000);
      this.update("recording");
      this.diagnostic("recording_started");
    } catch (error) {
      if (version !== this.version) return;
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      const missing = error instanceof DOMException && ["NotFoundError", "OverconstrainedError"].includes(error.name);
      if (missing) {
        this.fail("The selected microphone is unavailable. Choose another input.");
        return;
      }
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
                turn_detection: { type: "server_vad", silence_duration_ms: 700 },
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
        if (version === this.version && this.state === "transcribing") {
          this.finish();
          return;
        }
        if (version === this.version) this.fail("Speech connection closed before transcription finished. Try again.");
      };
    });
  }

  private send(frame: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private sendAudio(audio: ArrayBuffer): void {
    this.lastAudioAt = Date.now();
    this.packets++;
    const view = new DataView(audio);
    let sum = 0;
    for (let i = 0; i + 1 < view.byteLength; i += 2) sum += (view.getInt16(i, true) / 32768) ** 2;
    this.level = Math.min(1, Math.sqrt(sum / Math.max(1, view.byteLength / 2)) * 8);
    if (this.level > 0.01) this.audible = true;
    this.callbacks.changed?.();
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
    this.events++;
    if (frame.type === "error" || frame.type === "conversation.item.input_audio_transcription.failed") {
      this.fail("AllModels could not transcribe this audio. Check the API key, balance and STT model.");
      return;
    }
    const item = typeof frame.item_id === "string" ? frame.item_id : undefined;
    if (!item) return;
    if (frame.type === "conversation.item.input_audio_transcription.delta" && typeof frame.delta === "string") {
      if (this.completed.has(item)) return;
      const text = (this.previews.get(item) ?? "") + frame.delta;
      this.previews.set(item, text);
      this.callbacks.preview([...this.previews.values()].join(" "));
    }
    if (frame.type === "conversation.item.input_audio_transcription.completed") {
      if (!this.completed.has(item)) {
        this.completed.add(item);
        this.previews.delete(item);
        this.callbacks.preview([...this.previews.values()].join(" "));
        const text = typeof frame.transcript === "string" ? frame.transcript.trim() : "";
        if (text) {
          this.heardSpeech = true;
          this.callbacks.text(text);
        }
      }
    }
    if (
      frame.type === "conversation.item.input_audio_transcription.completed" &&
      this.state === "transcribing" &&
      this.commitSent &&
      !this.closeSent
    ) {
      clearTimeout(this.closeTimer);
      this.closeTimer = setTimeout(() => this.closeStream(), 150);
    }
  }

  private closeStream(): void {
    if (this.state !== "transcribing" || this.closeSent) return;
    this.closeSent = true;
    this.send({ type: "close" });
  }

  private finish(): void {
    const partial = [...this.previews.values()].join(" ").trim();
    if (partial) {
      this.heardSpeech = true;
      this.callbacks.preview("");
      this.callbacks.text(partial);
    }
    const heard = this.heardSpeech;
    this.diagnostic("finished");
    this.cancel();
    if (!heard) this.callbacks.error("No speech was recognized. Check the input meter and selected microphone.");
  }

  stop(): void {
    if (this.state !== "recording") return;
    clearTimeout(this.timer);
    this.update("transcribing");
    clearInterval(this.captureTimer);
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.capture?.port.postMessage("stop");
    this.timer = setTimeout(() => this.finish(), 5000);
  }

  cancel(): void {
    if (this.state === "idle") return;
    ++this.version;
    ++this.deviceVersion;
    clearTimeout(this.timer);
    clearTimeout(this.closeTimer);
    clearInterval(this.captureTimer);
    this.level = 0;
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
