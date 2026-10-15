import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";

test("dictation locks typing and distinguishes partial words until finalization", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="composer"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const requests: string[] = [];
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    fetch: async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({ runId: "queued-test", sessions: [] });
    },
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let composer: ComposerSurface | undefined;
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { createComposerSurface } = await vite.ssrLoadModule("/src/composer.ts");
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
    const { render } = await vite.ssrLoadModule("lit");
    appState.me = { user: "tester", org: "test", speechEnabled: true };
    const { SpeechInput } = await vite.ssrLoadModule("/src/speech.ts");
    let active!: {
      state: () => string;
      preview: (text: string) => void;
      text: (text: string) => void;
      finish: (success?: boolean) => void;
    };
    let finishStop: ((success: boolean) => void) | undefined;
    SpeechInput.prototype.stop = function (this: any) {
      this.state = "transcribing";
      this.callbacks.state("transcribing");
      return new Promise<boolean>((resolve) => {
        finishStop = resolve;
      });
    };
    SpeechInput.prototype.start = function (this: any) {
      active = {
        state: () => this.state,
        preview: this.callbacks.preview,
        text: this.callbacks.text,
        finish: (success = true) => {
          this.state = "idle";
          this.callbacks.state("idle");
          finishStop?.(success);
        },
      };
      this.state = "recording";
      this.callbacks.state("recording");
      this.callbacks.preview("streaming words");
    };
    const model = {
      id: "alpha",
      name: "Alpha",
      label: "Alpha",
      buttonLabel: "Alpha",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    };
    seedRuntimeConfig("personal:tester", {
      scopeId: "personal:tester",
      approvedHarnesses: ["pi"],
      modelsByHarness: { pi: ["alpha"] },
      modelCatalog: { alpha: model },
      orgDefault: { harnessId: "pi", modelId: "alpha", revision: 1 },
      effective: { harnessId: "pi", modelId: "alpha" },
      scopeOverride: null,
      upgradeAvailable: false,
    });
    const host = document.querySelector<HTMLElement>("#composer")!;
    let stopping = false;
    const agentState = { isStreaming: true, model, messages: [] };
    const agent = {
      state: agentState,
      prompt: async () => {},
    } as unknown as Agent;
    const draw = (): void => render(composer!.composerForm(agent), host);
    const ctx = {
      pane: false,
      chat: {
        state: {
          agent,
          host,
          threadRef: "web:tester:stopping",
          sessionId: "test-session",
          scopeId: null,
          resolvingApprovals: new Set<string>(),
        },
        activePendingApprovals: () => [],
        hasUnresolvedApproval: () => false,
        isStopping: () => stopping,
        drawActiveChat: draw,
        stopLiveRun: async () => {
          stopping = true;
          draw();
        },
        notePendingSessionOnSend() {},
        scrollToBottom() {},
      },
    } as unknown as ConvCtx;
    window.localStorage.setItem("qm.speech.microphone", "remembered-mic");
    const sent: string[] = [];
    composer = createComposerSurface(ctx, {
      prepareSubmit: () => async (text: string) => {
        sent.push(text);
      },
    });
    ctx.composer = composer!;
    const button = (selector: string): HTMLButtonElement => host.querySelector<HTMLButtonElement>(selector)!;
    const type = (value: string): void => {
      const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
      input.value = value;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    composer!.state.draft = "Keep";
    draw();
    assert.equal(host.querySelector("select[aria-label=Microphone]"), null);
    button(".composer-mic").click();
    assert.equal(host.querySelector<HTMLSelectElement>("select[aria-label=Microphone]")!.value, "remembered-mic");
    assert.equal(host.querySelector(".speech-status"), null);
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.value, "Keep streaming words");
    assert.ok(host.querySelector("canvas.speech-recording-waveform"));
    assert.ok(host.querySelector("[aria-label='Cancel dictation']"));
    assert.ok(host.querySelector("[aria-label='Stop recording']"));
    assert.equal(button(".send-btn").disabled, false);
    assert.equal(button(".send-btn").getAttribute("aria-label"), "Send");
    assert.equal(host.querySelector(".composer-left"), null);
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.readOnly, true);
    assert.equal(host.querySelector(".speech-partial")!.textContent, "streaming words");
    assert.equal(host.querySelector(".speech-input-display")!.textContent, "Keep streaming words");
    type("Overwrite the recording");
    assert.equal(active.state(), "recording");
    assert.equal(composer!.state.draft, "Keep");
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.value, "Keep streaming words");
    active.preview("");
    active.text("Streaming words.");
    assert.equal(host.querySelector(".speech-partial"), null);
    assert.equal(host.querySelector(".speech-input-display")!.textContent, "Keep Streaming words.");
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.readOnly, true);
    composer!.cancelSpeech();
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.readOnly, false);
    type("Edit after recording");
    assert.equal(composer!.state.draft, "Edit after recording");
    ctx.chat.state.sessionId = "after-first-message";
    ctx.chat.state.threadRef = "web:tester:after-first-message";
    composer!.state.draft = "";
    draw();
    button(".composer-mic").click();
    assert.ok(host.querySelector("canvas.speech-recording-waveform"));
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.value, "streaming words");
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    let scrollTop = 0;
    Object.defineProperties(input, {
      scrollHeight: { configurable: true, get: () => 500 },
      clientHeight: { configurable: true, get: () => 100 },
      offsetWidth: { configurable: true, get: () => 320 },
      clientWidth: { configurable: true, get: () => 305 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value) => {
          scrollTop = Math.min(400, Math.max(0, value));
        },
      },
    });
    active.preview("Long dictation follows the newest words");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const display = host.querySelector<HTMLElement>(".speech-input-display")!;
    assert.equal(input.scrollTop, 400);
    assert.equal(display.scrollTop, 400);
    assert.equal(display.style.paddingRight, "15px");
    input.scrollTop = 20;
    input.dispatchEvent(new dom.window.Event("scroll"));
    active.preview("New words do not interrupt reading earlier text");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(input.scrollTop, 20);
    assert.equal(display.scrollTop, 20);
    composer!.cancelSpeech();
    assert.equal(host.querySelector("canvas.speech-recording-waveform"), null);
    assert.ok(host.querySelector(".composer-left"));
    assert.equal(host.querySelector("select[aria-label=Microphone]"), null);
    agentState.isStreaming = false;
    composer!.state.draft = "Existing draft";
    draw();
    button(".composer-mic").click();
    button("[aria-label='Stop recording']").click();
    assert.equal(active.state(), "transcribing");
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.readOnly, true);
    active.preview("");
    active.text("Final words.");
    active.finish();
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.readOnly, false);
    assert.deepEqual(sent, []);
    type("Edited before sending");
    await composer!.submit();
    assert.deepEqual(sent, ["Edited before sending"]);

    button(".composer-mic").click();
    button(".send-btn").click();
    assert.equal(active.state(), "transcribing");
    assert.equal(button(".send-btn").disabled, true);
    assert.deepEqual(sent, ["Edited before sending"]);
    await composer!.submit();
    active.preview("");
    active.text("Final one-click instruction.");
    active.finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, ["Edited before sending", "Final one-click instruction."]);
    assert.equal(composer!.state.draft, "");

    button(".composer-mic").click();
    button(".send-btn").click();
    active.finish(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 2);
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.readOnly, false);

    button(".composer-mic").click();
    button(".send-btn").click();
    ctx.chat.state.threadRef = "web:tester:different-thread";
    active.finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 2);
  } finally {
    composer?.dispose();
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
