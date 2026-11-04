import type { AuditLog } from "../audit/audit-log.ts";
import { discordAlias, mintDiscordLinkTicket, unlinkDiscordAccount } from "../identity/discord-link.ts";
import type { PrincipalLinkService } from "../identity/principal-links.ts";
import type { RateLimiter } from "../ratelimit/rate-limiter.ts";
import type { DeploymentAccessRequest } from "../surfaces/deploy-access.ts";
import {
  availableRuntimeError,
  matchRuntimeModel,
  userRuntimeConfigBody,
  type RuntimeDeps,
} from "../api/runtime-config.ts";
import type { RuntimeChoice } from "../harness/harness.ts";
import type { ScopeId } from "../types.ts";
import {
  createSurfaceCoreClient,
  type SurfaceCoreClient,
  type SurfaceCoreClientDeps,
} from "../surfaces/surface-core-client.ts";

export interface DiscordCoreClient extends SurfaceCoreClient {
  linkedPrincipal(discordId: string): Promise<string | undefined>;
  linkUrl(discordId: string): Promise<string | undefined>;
  allowLinkPrompt(discordId: string): Promise<boolean>;
  unlink(discordId: string): Promise<boolean>;
  deploymentAccessRequest(deliveryId: string): Promise<DeploymentAccessRequest | undefined>;
  modelMenu(principalId: string, scope: ScopeId): Promise<ModelMenu | undefined>;
  setModel(principalId: string, scope: ScopeId, query: string): Promise<SetModelResult>;
}

export type ModelMenu = Awaited<ReturnType<typeof userRuntimeConfigBody>>;

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
}

export function createDiscordCoreClient(deps: DiscordCoreClientDeps): DiscordCoreClient {
  const linkedPrincipal = async (discordId: string): Promise<string | undefined> => {
    await deps.identity.refresh();
    const principal = deps.identity.classify(discordAlias(discordId));
    return deps.identity.isInternal(principal) ? principal.id : undefined;
  };
  const modelMenu = async (principalId: string, scope: ScopeId): Promise<ModelMenu | undefined> => {
    if (!deps.runtime?.config) return undefined;
    await deps.runtime.refreshModels?.();
    return userRuntimeConfigBody({ deps: deps.runtime }, scope, principalId);
  };
  return {
    ...createSurfaceCoreClient("discord", deps),

    modelMenu,

    async setModel(principalId, scope, query) {
      const runtime = deps.runtime;
      const menu = await modelMenu(principalId, scope);
      if (!runtime?.config || !menu) return { ok: false, error: "runtime_unavailable" };
      let choice: RuntimeChoice | null = null;
      if (query.toLowerCase() !== "default") {
        const match = matchRuntimeModel(menu, query, menu.approvedHarnesses);
        if (!match.ok) return match;
        choice = { harnessId: match.harnessId, modelId: match.modelId, effortLevel: "auto", fastMode: false };
        const error = await availableRuntimeError({ deps: runtime }, scope, choice, undefined, principalId);
        if (error) return { ok: false, error };
      }
      await runtime.config.setRuntimeSelectionLatest(scope, choice);
      deps.auditLog?.record({
        at: Date.now(),
        principalId,
        action: "runtime-config.update",
        resource: "runtime-config",
        scopeLabel: scope,
      });
      return { ok: true, choice };
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
