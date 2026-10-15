import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";

test("editing live speech keeps visible text and the saved draft in agreement", async () => {
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
    let active!: { state: () => string; preview: (text: string) => void; text: (text: string) => void };
    SpeechInput.prototype.start = function (this: any) {
      active = { state: () => this.state, preview: this.callbacks.preview, text: this.callbacks.text };
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
    composer = createComposerSurface(ctx);
    ctx.composer = composer!;
    const button = (selector: string): HTMLButtonElement => host.querySelector<HTMLButtonElement>(selector)!;
    const type = (value: string): void => {
      const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
      input.value = value;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    composer!.state.draft = "Keep";
    draw();
    assert.equal(host.querySelector<HTMLSelectElement>("select[aria-label=Microphone]")!.value, "remembered-mic");
    button(".composer-mic").click();
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.value, "Keep streaming words");
    type("Keep streaming words!");
    assert.equal(active.state(), "idle");
    assert.equal(composer!.state.draft, "Keep streaming words!");
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.value, "Keep streaming words!");
    composer!.state.draft = "Keep";
    draw();
    button(".composer-mic").click();
    type("Edited base streaming words");
    active.preview("");
    active.text("Streaming words.");
    assert.equal(composer!.state.draft, "Edited base Streaming words.");
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.value, "Edited base Streaming words.");
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
