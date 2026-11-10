import { html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { mountTemplate } from "./shared.ts";

type Provider = "anthropic" | "openai";
type Api = (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; data: any }>;
type Flow =
  | { provider: "anthropic"; authorizeUrl: string; verifier: string; code: string }
  | { provider: "openai"; userCode: string; verificationUrl: string };

const PROVIDERS: { id: Provider; name: string; route: string }[] = [
  { id: "anthropic", name: "Claude", route: "claude" },
  { id: "openai", name: "ChatGPT / Codex", route: "chatgpt" },
];
const BASE = "/api/model-accounts";

let api: Api = async () => ({ ok: false, data: null });
const state = {
  available: false,
  connections: [] as { provider: Provider; kind: string; needsReconnect?: boolean }[],
  flow: null as Flow | null,
  busy: false,
  message: "",
  error: false,
  attempt: 0,
};
let redraw = () => {};

export function configureModelAccounts(options: { api: Api }) {
  api = options.api;
}

export async function loadModelAccounts() {
  const res = await api("GET", BASE);
  state.available = res.ok;
  state.connections = res.ok ? res.data?.connections || [] : [];
  redraw();
}

function report(message: string, error = false) {
  state.message = message;
  state.error = error;
  state.busy = false;
  redraw();
}

function failure(res: { data: any }, fallback: string) {
  return res.data?.message || res.data?.error || fallback;
}

async function finish(name: string) {
  state.flow = null;
  await loadModelAccounts();
  report(`${name} connected. New turns use it right away.`);
}

async function pollChatGPT(attempt: number, deviceAuthId: string, intervalMs: number, expiresAt: number) {
  while (state.attempt === attempt && Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (state.attempt !== attempt) return;
    const res = await api("POST", `${BASE}/chatgpt/poll`, { deviceAuthId });
    if (state.attempt !== attempt) return;
    if (!res.ok) return report(failure(res, "ChatGPT sign-in failed. Start again."), true);
    if (res.data?.status === "connected") return finish("ChatGPT");
  }
  if (state.attempt === attempt) {
    state.flow = null;
    report("The ChatGPT code expired. Start again.", true);
  }
}

async function connect(provider: (typeof PROVIDERS)[number]) {
  const attempt = ++state.attempt;
  state.flow = null;
  state.busy = true;
  state.message = "";
  redraw();
  const res = await api("POST", `${BASE}/${provider.route}/start`, {});
  if (state.attempt !== attempt) return;
  if (!res.ok) return report(failure(res, `Could not start the ${provider.name} sign-in.`), true);
  state.busy = false;
  if (provider.id === "anthropic") {
    state.flow = { provider: "anthropic", authorizeUrl: res.data.authorizeUrl, verifier: res.data.verifier, code: "" };
    return redraw();
  }
  state.flow = { provider: "openai", userCode: res.data.userCode, verificationUrl: res.data.verificationUrl };
  redraw();
  void pollChatGPT(
    attempt,
    res.data.deviceAuthId,
    res.data.intervalMs || 5_000,
    res.data.expiresAt || Date.now() + 900_000,
  );
}

async function completeClaude() {
  const flow = state.flow;
  if (flow?.provider !== "anthropic" || !flow.code.trim()) return;
  state.busy = true;
  redraw();
  const res = await api("POST", `${BASE}/claude/complete`, { code: flow.code.trim(), verifier: flow.verifier });
  if (!res.ok) return report(failure(res, "Claude rejected that code. Start again."), true);
  return finish("Claude");
}

async function disconnect(provider: (typeof PROVIDERS)[number]) {
  if (!confirm(`Disconnect the organization's ${provider.name} login? Company-access turns on it stop working.`))
    return;
  state.attempt++;
  state.flow = null;
  state.busy = true;
  redraw();
  const res = await api("POST", `${BASE}/disconnect`, { provider: provider.id });
  if (!res.ok) return report(failure(res, `Could not disconnect ${provider.name}.`), true);
  await loadModelAccounts();
  report(`${provider.name} disconnected.`);
}

function cancel() {
  state.attempt++;
  state.flow = null;
  report("");
}

function flowFor(provider: Provider) {
  const flow = state.flow;
  if (flow?.provider !== provider) return nothing;
  if (flow.provider === "openai")
    return html`<div class="model-account-flow">
      <p>
        Open <a href=${flow.verificationUrl} target="_blank" rel="noopener noreferrer">${flow.verificationUrl}</a>, sign
        in with the ChatGPT account the organization should use, and enter this code:
      </p>
      <code class="model-account-code">${flow.userCode}</code>
      <p class="hint">Waiting for approval…</p>
      <div><button type="button" @click=${cancel}>Cancel</button></div>
    </div>`;
  return html`<div class="model-account-flow">
    <p>
      <a href=${flow.authorizeUrl} target="_blank" rel="noopener noreferrer">Open the Claude sign-in</a>, approve with
      the Claude account the organization should use, then paste the code it shows.
    </p>
    <input
      aria-label="Claude authorization code"
      autocomplete="off"
      .value=${flow.code}
      @input=${(e: Event) => {
        flow.code = (e.target as HTMLInputElement).value;
        redraw();
      }}
    />
    <div>
      <button type="button" @click=${cancel}>Cancel</button
      ><button class="primary" type="button" ?disabled=${state.busy || !flow.code.trim()} @click=${completeClaude}>
        Save login
      </button>
    </div>
  </div>`;
}

function row(provider: (typeof PROVIDERS)[number]) {
  const connection = state.connections.find((c) => c.provider === provider.id);
  let status = html`<span class="badge ok">Connected</span>`;
  if (!connection) status = html`<span class="badge muted">Not connected</span>`;
  else if (connection.needsReconnect) status = html`<span class="badge warn">Needs reconnect</span>`;
  return html`<div class="model-account-row">
      <span class="model-account-name">${provider.name}</span>${status}
      <span class="model-account-actions">
        <button type="button" ?disabled=${state.busy} @click=${() => connect(provider)}>
          ${connection ? "Reconnect" : "Connect"}</button
        >${
          connection
            ? html`<button class="danger" type="button" ?disabled=${state.busy} @click=${() => disconnect(provider)}>
                Disconnect
              </button>`
            : nothing
        }
      </span>
    </div>
    ${flowFor(provider.id)}`;
}

function template() {
  return html`<section
    class=${classMap({ card: true, "sv-models": true, hidden: !state.available })}
    id="card-model-accounts"
  >
    <div class="head">
      <h2>Organization AI subscriptions</h2>
      <p>The Claude and ChatGPT logins that company-access turns run on. Reconnect one when it expires.</p>
    </div>
    <div class="body">${PROVIDERS.map(row)}</div>
    <div class="foot">
      <span class=${classMap({ status: true, err: state.error, idle: !state.message })} aria-live="polite"
        >${state.message}</span
      >
    </div>
  </section>`;
}

export function mountModelAccounts() {
  redraw = mountTemplate('template[data-settings-card="card-model-accounts"]', template);
}
