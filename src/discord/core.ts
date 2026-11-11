import type { DiscordChannels } from "./channel-directory.ts";
import type { Transcribe } from "../model/transcribe.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { discordAlias, mintDiscordLinkTicket, unlinkDiscordAccount } from "../identity/discord-link.ts";
import type { PrincipalLinkService } from "../identity/principal-links.ts";
import type { RateLimiter } from "../ratelimit/rate-limiter.ts";
import type { DeploymentAccessRequest } from "../surfaces/deploy-access.ts";
import {
  availableRuntimeError,
  matchRuntimeModel,
  validateRuntimeChoice,
  userRuntimeConfigBody,
  type RuntimeDeps,
} from "../api/runtime-config.ts";
import { setSessionRuntime } from "../api/session-runtime.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { RuntimeChoice } from "../harness/harness.ts";
import type { Session, SessionRuntime, TurnOrigin } from "../types.ts";
import { resolveTurnOrigin, resumesOwnersTask } from "../core/turn-origin.ts";
import { deliversRunResult } from "../delivery/run-result-delivery.ts";
import {
  createSurfaceCoreClient,
  type SurfaceCoreClient,
  type SurfaceCoreClientDeps,
} from "../surfaces/surface-core-client.ts";

export type WatchableRun = { runId: string; threadRef: string; placeholder?: string } & (
  { kind: "reply"; target: string; dm: boolean; origin: TurnOrigin } | { kind: "status" }
);

export interface DiscordCoreClient extends SurfaceCoreClient {
  watchableRuns(): Promise<WatchableRun[]>;
  linkedPrincipal(discordId: string): Promise<string | undefined>;
  linkUrl(discordId: string): Promise<string | undefined>;
  allowLinkPrompt(discordId: string): Promise<boolean>;
  unlink(discordId: string): Promise<boolean>;
  deploymentAccessRequest(deliveryId: string): Promise<DeploymentAccessRequest | undefined>;
  modelMenu(
    principalId: string,
    threadRef: string,
    opts?: { refresh?: boolean },
  ): Promise<SessionModels | null | undefined>;
  setModel(principalId: string, threadRef: string, query: string): Promise<SetModelResult>;
  rememberChannel(channelId: string, guildId: string): Promise<void>;
  transcribe?: Transcribe;
}

export type ModelMenu = Awaited<ReturnType<typeof userRuntimeConfigBody>>;

export interface SessionModels {
  session: Session;
  menu: ModelMenu;
  current: SessionRuntime;
  skipped?: SessionRuntime;
}

export type SetModelResult =
  | { ok: true; choice: RuntimeChoice | null }
  | { ok: false; error: string; candidates?: Array<{ harnessId: string; modelId: string }> };

export interface DiscordCoreClientDeps extends SurfaceCoreClientDeps {
  principalLinks: Pick<PrincipalLinkService, "unlink">;
  linkPrompts: RateLimiter;
  orgId: string;
  signingSecret?: string;
  portalUrl?: string;
  auditLog?: Pick<AuditLog, "record">;
  runtime?: RuntimeDeps;
  sessions: Pick<SessionStore, "getByThread" | "getForParticipant" | "setRuntime">;
  discordChannels: Pick<DiscordChannels, "remember">;
  transcribe?: Transcribe;
}

export function createDiscordCoreClient(deps: DiscordCoreClientDeps): DiscordCoreClient {
  const linkedPrincipal = async (discordId: string): Promise<string | undefined> => {
    await deps.identity.refresh();
    const principal = deps.identity.classify(discordAlias(discordId));
    return deps.identity.isInternal(principal) ? principal.id : undefined;
  };
  const modelMenu = async (
    principalId: string,
    threadRef: string,
    opts: { refresh?: boolean } = {},
  ): Promise<SessionModels | null | undefined> => {
    if (!deps.runtime?.config) return undefined;
    const thread = await deps.sessions.getByThread(threadRef);
    const session = thread && (await deps.sessions.getForParticipant(thread.id, principalId));
    if (!session) return null;
    if (opts.refresh !== false) await deps.runtime.refreshModels?.();
    const menu = await userRuntimeConfigBody({ deps: deps.runtime }, session.scopeId, principalId);
    const pinned = session.runtime;
    if (!pinned || opts.refresh === false) return { session, menu, current: pinned ?? menu.effective };
    const problem = await availableRuntimeError(
      { deps: deps.runtime },
      session.scopeId,
      pinned,
      undefined,
      principalId,
    );
    return !problem ? { session, menu, current: pinned } : { session, menu, current: menu.effective, skipped: pinned };
  };
  return {
    ...createSurfaceCoreClient("discord", deps),
    async watchableRuns() {
      const watchable: WatchableRun[] = [];
      for (const threadRef of await deps.runs.activeSessionIds()) {
        if (!threadRef.startsWith("discord:")) continue;
        const run = await deps.runs.activeForThread(threadRef);
        if (!run || !deliversRunResult(run)) continue;
        const placeholder = run.deliveryState?.editRef ? undefined : run.deliveryState?.replyRef;
        const seen = { runId: run.id, threadRef, ...(placeholder ? { placeholder } : {}) };
        if (resumesOwnersTask(run.request)) {
          watchable.push({ ...seen, kind: "status" });
          continue;
        }
        const origin = resolveTurnOrigin(run.request);
        const target = run.request.deliveryTarget;
        if (run.request.surface !== "discord" || !target || origin.kind === "ambient") continue;
        watchable.push({ ...seen, kind: "reply", target, dm: run.request.conversation.kind === "dm", origin });
      }
      return watchable;
    },

    modelMenu,

    rememberChannel: (channelId, guildId) => deps.discordChannels.remember(channelId, guildId),

    ...(deps.transcribe ? { transcribe: deps.transcribe } : {}),

    async setModel(principalId, threadRef, query) {
      const runtime = deps.runtime;
      const found = await modelMenu(principalId, threadRef);
      if (!runtime || found === undefined) return { ok: false, error: "runtime_unavailable" };
      if (!found) return { ok: false, error: "no_session" };
      const { session, menu } = found;
      const current = found.skipped ?? found.current;
      let choice: RuntimeChoice | null = null;
      if (query.toLowerCase() !== "default") {
        const match = matchRuntimeModel(menu, query, menu.approvedHarnesses);
        if (!match.ok) return match;
        const kept = {
          harnessId: match.harnessId,
          modelId: match.modelId,
          effortLevel: current.effortLevel ?? "auto",
          fastMode: current.fastMode ?? false,
        };
        choice = validateRuntimeChoice(kept) ? { ...kept, effortLevel: "auto", fastMode: false } : kept;
      }
      const out = await setSessionRuntime(
        { sessions: deps.sessions, runtime, ...(deps.auditLog ? { auditLog: deps.auditLog } : {}) },
        session,
        principalId,
        choice,
      );
      return out.ok ? { ok: true, choice } : { ok: false, error: out.error };
    },

    linkedPrincipal,

    async linkUrl(discordId) {
      const base = deps.portalUrl?.replace(/\/+$/, "");
      if (!base || !deps.signingSecret) return undefined;
      const ticket = await mintDiscordLinkTicket(discordId, deps.orgId, deps.signingSecret);
      return `${base}/connect/discord?${new URLSearchParams({ t: ticket }).toString()}`;
    },

    async allowLinkPrompt(discordId) {
      return (await deps.linkPrompts.check(`discord-link-prompt:${discordId}`)).allowed;
    },

    async deploymentAccessRequest(deliveryId) {
      return (await deps.deliveries.get(deliveryId))?.destination.deploymentAccess;
    },

    async unlink(discordId) {
      const link = await unlinkDiscordAccount(
        { links: deps.principalLinks, identity: deps.identity, auditLog: deps.auditLog },
        discordId,
        (await linkedPrincipal(discordId)) ?? discordAlias(discordId),
      );
      return link !== null;
    },
  };
}
