import type { AuditLog } from "../audit/audit-log.ts";
import { discordAlias, mintDiscordLinkTicket, unlinkDiscordAccount } from "../identity/discord-link.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { PrincipalLinkService } from "../identity/principal-links.ts";
import type { RateLimiter } from "../ratelimit/rate-limiter.ts";
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
}

export interface DiscordCoreClientDeps extends SurfaceCoreClientDeps {
  identity: Pick<IdentityService, "classify" | "isInternal" | "refresh">;
  principalLinks: Pick<PrincipalLinkService, "unlink">;
  linkPrompts: RateLimiter;
  orgId: string;
  signingSecret?: string;
  portalUrl?: string;
  auditLog?: Pick<AuditLog, "record">;
}

export function createDiscordCoreClient(deps: DiscordCoreClientDeps): DiscordCoreClient {
  const linkedPrincipal = async (discordId: string): Promise<string | undefined> => {
    await deps.identity.refresh();
    const principal = deps.identity.classify(discordAlias(discordId));
    return deps.identity.isInternal(principal) ? principal.id : undefined;
  };
  return {
    ...createSurfaceCoreClient("discord", deps),

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
