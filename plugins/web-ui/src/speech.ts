export type SpeechState = "idle" | "starting" | "recording" | "transcribing";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DURATION_MS = 120_000;

export interface SpeechCallbacks {
  state: (state: SpeechState) => void;
  text: (text: string) => void;
  error: (message: string) => void;
  transcribe: (audio: Blob, signal: AbortSignal) => Promise<{ text: string }>;
}

export class SpeechInput {
  state: SpeechState = "idle";
  private version = 0;
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;

  private readonly callbacks: SpeechCallbacks;

  constructor(callbacks: SpeechCallbacks) {
    this.callbacks = callbacks;
  }

  private update(state: SpeechState): void {
    this.state = state;
    this.callbacks.state(state);
  }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    const version = ++this.version;
    this.update("starting");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
        throw new Error("This browser does not support microphone input. Use HTTPS and a current browser.");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (version !== this.version) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((mime) =>
        MediaRecorder.isTypeSupported(mime),
      );
      if (!mimeType) throw new Error("This browser cannot record a supported audio format.");
      const recorder = new MediaRecorder(stream, { mimeType });
      this.recorder = recorder;
      const chunks: Blob[] = [];
      let bytes = 0;
      recorder.ondataavailable = (event) => {
        if (version !== this.version || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > MAX_BYTES) {
          this.cancel();
          this.callbacks.error("Recording is too large. Try a shorter instruction.");
          return;
        }
        chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (version !== this.version) return;
        this.cancel();
        this.callbacks.error("The microphone stopped working. Try again.");
      };
      recorder.onstop = () => {
        if (version !== this.version) return;
        this.releaseMicrophone();
        if (this.state !== "transcribing") this.update("transcribing");
        void this.finish(new Blob(chunks, { type: mimeType }), version);
      };
      recorder.start(250);
      this.timer = setTimeout(() => this.stop(), MAX_DURATION_MS);
      this.update("recording");
    } catch (error) {
      if (version !== this.version) return;
      this.cancel();
      let message = "Could not open the microphone.";
      if (error instanceof Error) message = error.message;
      if (error instanceof DOMException && error.name === "NotAllowedError")
        message = "Microphone access was denied. Allow it in your browser settings and try again.";
      this.callbacks.error(message);
    }
  }

  stop(): void {
    if (this.state !== "recording") return;
    clearTimeout(this.timer);
    this.update("transcribing");
    this.recorder?.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
  }

  private releaseMicrophone(): void {
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.recorder = undefined;
  }

  private async finish(audio: Blob, version: number): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 65_000);
    try {
      if (!audio.size) throw new Error("The recording was empty. Try again.");
      const result = await this.callbacks.transcribe(audio, controller.signal);
      if (version !== this.version) return;
      if (!result.text?.trim()) throw new Error("No speech was detected. Try again.");
      this.callbacks.text(result.text.trim());
    } catch (error) {
      if (version === this.version) {
        let message = error instanceof Error ? error.message : "Speech transcription failed.";
        if (controller.signal.aborted) message = "Transcription timed out. Try again.";
        this.callbacks.error(message);
      }
    } finally {
      clearTimeout(timeout);
      if (version === this.version) {
        this.controller = undefined;
        this.update("idle");
      }
    }
  }

  cancel(): void {
    if (this.state === "idle") return;
    ++this.version;
    this.controller?.abort();
    this.controller = undefined;
    if (this.recorder) {
      this.recorder.onstop = null;
      if (this.recorder.state !== "inactive") this.recorder.stop();
    }
    this.releaseMicrophone();
    this.update("idle");
  }
}
