import type { KeychainApprovalView } from "../credentials/keychain-approval.ts";
import type { StoredApprovalView } from "../surfaces/surface-core-client.ts";
import { safeClip } from "../surfaces/safe-cut.ts";
import { parseScopeId } from "../types.ts";
import { DISCORD_MESSAGE_LIMIT, type DiscordButton } from "./api.ts";

export interface DiscordCard {
  content: string;
  buttons: DiscordButton[];
}

const COMMAND_SCOPES = ["once", "session", "always", "deny"] as const;
const KEYCHAIN_DECISIONS = ["once", "standing", "deny"] as const;
const DEPLOY_DECISIONS = ["approve", "decline"] as const;

export type ApprovalButton =
  | { kind: "command"; id: string; scope: (typeof COMMAND_SCOPES)[number] }
  | { kind: "keychain"; id: string; decision: (typeof KEYCHAIN_DECISIONS)[number] }
  | { kind: "deploy"; id: string; approve: boolean };

const ID = /^[A-Za-z0-9_-]{1,80}$/;

export function parseApprovalButton(customId: string): ApprovalButton | null {
  const [prefix, kind, choice = "", id = "", ...rest] = customId.split(":");
  if (prefix !== "qm" || rest.length || !ID.test(id)) return null;
  if (kind === "cmd" && (COMMAND_SCOPES as readonly string[]).includes(choice))
    return { kind: "command", id, scope: choice as (typeof COMMAND_SCOPES)[number] };
  if (kind === "key" && (KEYCHAIN_DECISIONS as readonly string[]).includes(choice))
    return { kind: "keychain", id, decision: choice as (typeof KEYCHAIN_DECISIONS)[number] };
  if (kind === "app" && (DEPLOY_DECISIONS as readonly string[]).includes(choice))
    return { kind: "deploy", id, approve: choice === "approve" };
  return null;
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|]/g, "\\$&");
}

function code(text: string): string {
  const clean = text.replaceAll("`", "ˋ");
  return `\`${safeClip(clean, 600)}\``;
}

function card(lines: string[], buttons: DiscordButton[]): DiscordCard {
  return { content: safeClip(lines.join("\n"), DISCORD_MESSAGE_LIMIT), buttons };
}

export function commandApprovalCard(approval: StoredApprovalView): DiscordCard {
  const input = approval.kind === "input";
  const lines = [
    input ? "🔒 **My security screen flagged part of this message. Allow it?**" : "🔒 **Approval needed.**",
  ];
  if (approval.summary) lines.push(escapeMarkdown(safeClip(approval.summary, 400)));
  if (approval.purpose) lines.push(`**Why:** ${escapeMarkdown(safeClip(approval.purpose, 400))}`);
  if (!input) lines.push(`**Command:** ${code(approval.command)}`);
  lines.push(`**Flagged as:** ${escapeMarkdown(safeClip(approval.reason ?? "requires approval", 200))}`);
  const id = (scope: (typeof COMMAND_SCOPES)[number]) => `qm:cmd:${scope}:${approval.requestId}`;
  return card(lines, [
    { id: id("once"), label: "Allow once", style: "primary" },
    ...(approval.grantModes?.session === false
      ? []
      : [{ id: id("session"), label: "Allow session", style: "secondary" as const }]),
    ...(approval.grantModes?.always === false
      ? []
      : [{ id: id("always"), label: "Allow always", style: "secondary" as const }]),
    { id: id("deny"), label: "Deny", style: "danger" },
  ]);
}

export function commandDecisionText(scope: (typeof COMMAND_SCOPES)[number], command: string): string {
  if (scope === "deny") return `Denied ${code(command)}.`;
  const label = { once: "Allowed once", session: "Allowed for this conversation", always: "Allowed always" }[scope];
  return `${label}: ${code(command)}.`;
}

export function keychainCard(view: KeychainApprovalView): DiscordCard {
  const { ask } = view;
  const pending = ask.status === "pending";
  const { kind } = parseScopeId(ask.requesterScopeId);
  let audience = "this group";
  if (kind === "personal") audience = "your personal conversations";
  if (kind === "channel") audience = "this channel";
  const standing = `ongoing access across ${audience}`;
  const duration = pending ? ` (${ask.requestedMode === "once" ? "one-time access" : standing})` : "";
  const summary = `Use your **${escapeMarkdown(safeClip(view.service, 150))}** credential in ${escapeMarkdown(
    safeClip(view.conversation, 200),
  )}${duration}.`;
  if (!pending) {
    let status = "This request expired.";
    if (ask.status === "approved") status = `Approved — ${view.mode === "standing" ? standing : "one-time access"}.`;
    if (ask.status === "declined") status = "Denied.";
    return card([`**${status}**`, summary], []);
  }
  const id = (decision: (typeof KEYCHAIN_DECISIONS)[number]) => `qm:key:${decision}:${ask.id}`;
  const once: DiscordButton = { id: id("once"), label: "Allow once", style: "secondary" };
  const always: DiscordButton = { id: id("standing"), label: "Allow", style: "secondary" };
  const [first, second] = ask.requestedMode === "once" ? [once, always] : [always, once];
  return card(
    ["🔒 **Approval needed.**", summary],
    [{ ...first!, style: "primary" }, second!, { id: id("deny"), label: "Deny", style: "danger" }],
  );
}

export function deployAccessCard(text: string, deliveryId: string): DiscordCard {
  return card(
    [escapeMarkdown(text)],
    [
      { id: `qm:app:approve:${deliveryId}`, label: "Approve", style: "primary" },
      { id: `qm:app:decline:${deliveryId}`, label: "Decline", style: "danger" },
    ],
  );
}
