const PITCH = 4;
const BASELINE = 0.025;

export class SpeechWaveform {
  private canvas?: HTMLCanvasElement;
  private observer?: ResizeObserver;
  private samples: number[] = [];
  private reducedMotion?: MediaQueryList;

  readonly attach = (element?: Element): void => {
    if (element === this.canvas) return;
    this.observer?.disconnect();
    this.reducedMotion?.removeEventListener?.("change", this.draw);
    this.canvas = element as HTMLCanvasElement | undefined;
    if (!this.canvas) return;
    this.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.reducedMotion?.addEventListener?.("change", this.draw);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(this.draw);
      this.observer.observe(this.canvas);
    }
    this.draw();
  };

  push(level: number): void {
    const normalized = Number.isFinite(level)
      ? Math.max(BASELINE, Math.min(1, Math.pow(Math.max(0, level), 0.72)))
      : BASELINE;
    this.samples.push(normalized);
    if (this.samples.length > 1024) this.samples.shift();
    this.draw();
  }

  reset(): void {
    this.samples = [];
    this.draw();
  }

  dispose(): void {
    this.attach();
    this.samples = [];
  }

  private readonly draw = (): void => {
    const canvas = this.canvas;
    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.floor(canvas.clientWidth * ratio);
    const height = Math.floor(canvas.clientHeight * ratio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const count = Math.max(1, Math.floor(canvas.clientWidth / PITCH));
    const recent = this.samples.slice(-count);
    const missing = count - recent.length;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = getComputedStyle(canvas).color || "#a8a8a8";
    for (let index = 0; index < count; index++) {
      const sample = this.reducedMotion?.matches ? (recent.at(-1) ?? BASELINE) : (recent[index - missing] ?? BASELINE);
      const barHeight = Math.max(1.5 * ratio, sample * height * 0.88);
      context.globalAlpha = sample <= BASELINE ? 0.24 : 0.92;
      context.fillRect((index * width) / count, (height - barHeight) / 2, Math.max(1, width / count / 2), barHeight);
    }
    context.globalAlpha = 1;
  };
}
