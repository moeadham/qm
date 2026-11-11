import { redactSecrets } from "../harness/redact-secrets.ts";
import { safeClip } from "../surfaces/safe-cut.ts";
import type { ToolCallView } from "../surfaces/surface-core-client.ts";
import { escapeMarkdown } from "./approval-cards.ts";

const TOOL_ARGS_LIMIT = 300;
const ACTIVITY_PHRASES = [
  ["read", "Read files"],
  ["execute", "Ran commands"],
  ["other", "Used tools"],
] as const;

export type ActivityKind = (typeof ACTIVITY_PHRASES)[number][0];

export function activityKind(call: ToolCallView): ActivityKind {
  const action = call.args.action;
  if ((call.tool === "files" || call.tool === "skills") && action === "read") return "read";
  if (call.tool === "execute" && call.args.background !== true) return "execute";
  if (call.tool === "sandbox" && action === "exec") return "execute";
  return "other";
}

function elapsedLabel(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function activityHeader(prefix: string, ms: number, kinds: ReadonlySet<ActivityKind>): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  const summary = ACTIVITY_PHRASES.filter(([kind]) => kinds.has(kind))
    .map(([, phrase], i) => (i ? phrase.toLowerCase() : phrase))
    .join(", ");
  return [secs > 0 ? `${prefix} for ${elapsedLabel(secs)}` : prefix, summary].filter(Boolean).join(" · ");
}

export function toolCallLine(call: ToolCallView): string {
  const purpose = typeof call.args.purpose === "string" ? call.args.purpose.replace(/\s+/g, " ").trim() : "";
  if (purpose) return `🔧 ${escapeMarkdown(safeClip(redactSecrets(purpose), TOOL_ARGS_LIMIT))}`;
  const args = safeClip(redactSecrets(JSON.stringify(call.args)), TOOL_ARGS_LIMIT);
  return `🔧 \`${`${call.tool} ${args}`.replaceAll("`", "ˋ")}\``;
}
