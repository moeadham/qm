class SpeechCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2400);
    this.size = 0;
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        this.active = false;
        this.flush();
        this.port.postMessage("flushed");
      }
    };
  }

  flush() {
    if (!this.size) return;
    const bytes = new ArrayBuffer(this.size * 2);
    const view = new DataView(bytes);
    for (let i = 0; i < this.size; i++) {
      const sample = Math.max(-1, Math.min(1, this.samples[i]));
      view.setInt16(i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    this.port.postMessage(bytes, [bytes]);
    this.size = 0;
  }

  process(inputs) {
    if (!this.active) return false;
    const samples = inputs[0]?.[0];
    if (samples) {
      for (const sample of samples) {
        this.samples[this.size++] = sample;
        if (this.size === this.samples.length) this.flush();
      }
    }
    return true;
  }
}

registerProcessor("qm-speech-capture", SpeechCapture);
