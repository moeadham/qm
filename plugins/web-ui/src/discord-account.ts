import { LitElement, html, nothing } from "lit";
import { ArrowUpRight, Check, Link2, UserRound } from "lucide";
import { discordMark } from "./ui";
import { icon } from "./icons";
import "./slack-account.css";
import "./discord-account.css";
import { withBase } from "./core-bridge";

interface DiscordLinkStatus {
  configured: boolean;
  linked: boolean;
  discordId?: string;
  username?: string;
  linkedAt?: number;
}

type Notice = { text: string; ok: boolean };

const RESULT_NOTICES: Record<string, Notice> = {
  connected: { text: "Discord linked. The QM bot now accepts your messages.", ok: true },
  wrong_account: {
    text: "You signed in to a different Discord account than the one that messaged the bot.",
    ok: false,
  },
  wrong_session: { text: "Finish linking in the same browser where you started, signed in as yourself.", ok: false },
  already_linked: { text: "Your QM account already has a linked Discord account. Unlink it first.", ok: false },
  linked_elsewhere: { text: "That Discord account is linked to another QM user.", ok: false },
  inactive: { text: "Your QM account isn't active.", ok: false },
  denied: { text: "Discord linking was cancelled.", ok: false },
};

let pageNotice: Notice | null = null;

export function captureDiscordReturn(href: string): void {
  const url = new URL(href);
  const result = url.searchParams.get("discord");
  if (!result) return;
  pageNotice = RESULT_NOTICES[result] ?? { text: "Discord linking failed. Try again.", ok: false };
  url.searchParams.delete("discord");
  history.replaceState(history.state, "", url);
}

function linkedSince(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export class DiscordAccount extends LitElement {
  static properties = {
    status: { state: true },
    busy: { state: true },
    notice: { state: true },
  };
  private status: DiscordLinkStatus | null = null;
  private busy = false;
  private notice: Notice | null = null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  constructor() {
    super();
    this.hidden = true;
    this.notice = pageNotice;
    pageNotice = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("focus", this.refresh);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("focus", this.refresh);
  }

  private refresh = (): void => {
    void this.load();
  };

  protected firstUpdated(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const response = await fetch(withBase("/api/discord-link"), {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      this.status = (await response.json()) as DiscordLinkStatus;
    } catch {
      return;
    }
  }

  private async unlink(): Promise<void> {
    if (this.busy) return;
    if (!window.confirm("Unlink your Discord account? The QM bot will stop accepting your messages.")) return;
    this.busy = true;
    this.notice = null;
    try {
      const response = await fetch(withBase("/api/discord-link"), {
        method: "DELETE",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok && response.status !== 404) throw Error("Could not unlink Discord. Try again.");
      this.status = { configured: this.status?.configured ?? true, linked: false };
      this.notice = { text: "Discord unlinked.", ok: true };
    } catch (error) {
      this.notice = { text: error instanceof Error ? error.message : "Could not unlink Discord.", ok: false };
    } finally {
      this.busy = false;
    }
  }

  private renderNotice() {
    if (!this.notice) return nothing;
    return html`<p class=${this.notice.ok ? "discord-account-notice" : "slack-account-error"} role="status">
      ${this.notice.text}
    </p>`;
  }

  protected willUpdate(): void {
    this.hidden = !this.status?.configured && !this.notice;
  }

  protected render() {
    const status = this.status;
    if (!status?.configured) return this.notice ? html`<section>${this.renderNotice()}</section>` : nothing;
    const account = status.username ? `@${status.username}` : status.discordId && `ID ${status.discordId}`;
    const detail = [account, status.linkedAt ? `linked ${linkedSince(status.linkedAt)}` : ""]
      .filter(Boolean)
      .join(" · ");
    return html`<section class="discord-account" aria-label="Your Discord account">
      ${
        status.linked
          ? html`<div class="discord-linked">
              <div class="discord-logo" aria-hidden="true">${discordMark(22)}</div>
              <span class="discord-linked-text"
                ><strong>${icon(Check, 14)}Discord account linked</strong
                >${detail ? html`<small>${detail}</small>` : nothing}</span
              >
              <button class="btn" type="button" ?disabled=${this.busy} @click=${() => void this.unlink()}>
                ${this.busy ? "Unlinking…" : "Unlink"}
              </button>
            </div>`
          : html`<a class="welcome-slack" href="/connect/discord">
              <div class="slack-link-icon" aria-hidden="true">
                <span class="slack-link-person">${icon(UserRound, 17)}</span>
                <span class="slack-link-service">${discordMark(16)}</span>
                <span class="slack-link-chain">${icon(Link2, 13)}</span>
              </div>
              <span
                ><strong>Link your Discord account</strong
                ><small>Let the QM bot accept your messages in Discord.</small></span
              >
              ${icon(ArrowUpRight, 16)}
            </a>`
      }
      ${this.renderNotice()}
    </section>`;
  }
}

if (!customElements.get("qm-discord-account")) customElements.define("qm-discord-account", DiscordAccount);
