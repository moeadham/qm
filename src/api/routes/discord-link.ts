import { orgId as configOrgId } from "../../config.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../auth/portal-identity.ts";
import { codeChallengeS256, generateCodeVerifier } from "../../connectors/oauth.ts";
import { createEnvSecretSource } from "../../credentials/secret-source.ts";
import { canonicalPerson, samePerson } from "../../directory/person.ts";
import { PrincipalLinkError } from "../../identity/principal-links.ts";
import {
  DISCORD_LINK_CALLBACK_PATH,
  DISCORD_LINK_PROVIDER,
  discordAlias,
  discordAuthorizeUrl,
  linkedDiscordId,
  verifiedDiscordUser,
  unlinkDiscordAccount,
  verifyDiscordLinkTicket,
  type DiscordFetch,
  type DiscordOAuthClient,
} from "../../identity/discord-link.ts";
import type { ServerDeps } from "../deps.ts";
import { headerValue, sendJson, sendRedirect } from "../http.ts";
import { beginOAuthFlow, resumeOAuthFlow } from "./connectors.ts";
import { activePrincipal, audit } from "./shared.ts";
import type { ApiCtx, BaseCtx, Route } from "./route.ts";

async function discordClient(deps: ServerDeps): Promise<DiscordOAuthClient | null> {
  const env = createEnvSecretSource(deps.oauthEnv);
  const [id, secret] = await Promise.all([env.get("DISCORD_APPLICATION_ID"), env.get("DISCORD_CLIENT_SECRET")]);
  return id && secret ? { id, secret } : null;
}

function callbackUrl(deps: ServerDeps): string | null {
  const base = deps.portalUrl?.replace(/\/$/, "");
  return base ? `${base}${DISCORD_LINK_CALLBACK_PATH}` : null;
}

function discordFetch(deps: ServerDeps): DiscordFetch {
  const injected = deps.oauthFetch;
  return injected ? (url, init) => injected(url, { ...init, body: init.body ?? "" }) : (url, init) => fetch(url, init);
}

function signedInPrincipal(ctx: ApiCtx): string | null {
  if (!ctx.actor || ctx.actor.imp || ctx.capability) {
    sendJson(ctx.res, 403, { error: "forbidden", message: "Sign in to QM as yourself to manage your Discord link." });
    return null;
  }
  return ctx.actor.p;
}

async function browserPrincipal(ctx: BaseCtx): Promise<string | null> {
  const token = headerValue(ctx.req, PORTAL_IDENTITY_HEADER);
  const secret = ctx.deps.portalIdentitySecret ?? ctx.secret;
  const identity = token && secret ? await verifyPortalIdentity(token, secret, Date.now()) : null;
  return identity && !identity.imp ? identity.p : null;
}

function finish(res: BaseCtx["res"], status: string): void {
  return sendRedirect(res, `/connectors?${new URLSearchParams({ connector: "discord", status }).toString()}`);
}

async function discordLinkStatus(ctx: ApiCtx): Promise<void> {
  const principal = signedInPrincipal(ctx);
  if (!principal) return;
  await ctx.deps.principalLinks?.refresh(true);
  const discordId = linkedDiscordId(principal);
  return sendJson(ctx.res, 200, {
    configured: (await discordClient(ctx.deps)) !== null,
    linked: discordId !== undefined,
    ...(discordId ? { discordId } : {}),
  });
}

async function discordLinkStart(ctx: ApiCtx): Promise<void> {
  const { res, deps, secret, url } = ctx;
  const principal = signedInPrincipal(ctx);
  if (!principal) return;
  if (!deps.principalLinks || !(await activePrincipal(deps, principal)))
    return sendJson(res, 403, { error: "forbidden", message: "Your QM account can't link Discord." });
  const client = await discordClient(deps);
  const redirectUri = callbackUrl(deps);
  if (!client || !redirectUri)
    return sendJson(res, 501, {
      error: "not_configured",
      message: "Discord linking isn't set up — set DISCORD_APPLICATION_ID, DISCORD_CLIENT_SECRET and the portal URL.",
    });
  const ticket = url.searchParams.get("t");
  let subject: string | undefined;
  if (ticket) {
    const discordId = deps.signingSecret
      ? await verifyDiscordLinkTicket(ticket, configOrgId(), deps.signingSecret)
      : null;
    if (!discordId)
      return sendJson(res, 400, {
        error: "invalid_link",
        message: "This Discord link expired. Message the bot again for a fresh one.",
      });
    subject = discordId;
  }
  const codeVerifier = generateCodeVerifier();
  const state = await beginOAuthFlow(deps, secret, {
    provider: DISCORD_LINK_PROVIDER,
    principalId: canonicalPerson(principal),
    redirectUri,
    orgId: configOrgId(),
    codeVerifier,
    ...(subject ? { subject } : {}),
  });
  audit(deps, {
    principalId: principal,
    action: "discord_link.start",
    resource: subject ? discordAlias(subject) : "discord",
    scopeLabel: principal,
  });
  return sendJson(res, 200, {
    authorizeUrl: discordAuthorizeUrl({ client, redirectUri, state, codeChallenge: codeChallengeS256(codeVerifier) }),
  });
}

async function discordLinkCallback(ctx: BaseCtx): Promise<void> {
  const { res, deps, secret, url } = ctx;
  if (url.searchParams.get("error")) return finish(res, "denied");
  const code = url.searchParams.get("code") ?? "";
  const stateParam = url.searchParams.get("state") ?? "";
  const links = deps.principalLinks;
  const client = await discordClient(deps);
  if (!code || !stateParam || !links || !client) return finish(res, "failed");
  try {
    const state = await resumeOAuthFlow(deps, secret, stateParam);
    if (state.provider !== DISCORD_LINK_PROVIDER || state.orgId !== configOrgId() || !state.codeVerifier)
      return finish(res, "failed");
    if (!samePerson(await browserPrincipal(ctx), state.principalId)) return finish(res, "wrong_session");
    const user = await verifiedDiscordUser({
      client,
      code,
      redirectUri: state.redirectUri,
      codeVerifier: state.codeVerifier,
      fetchImpl: discordFetch(deps),
    });
    if (state.subject && state.subject !== user.id) return finish(res, "wrong_account");
    if (!(await activePrincipal(deps, state.principalId))) return finish(res, "inactive");
    const alias = discordAlias(user.id);
    try {
      await links.link({
        principalId: alias,
        canonicalId: state.principalId,
        evidence: `Discord OAuth user ${user.id} (${user.username})`,
        linkedBy: state.principalId,
      });
    } catch (error) {
      if (!(error instanceof PrincipalLinkError) || error.status !== 409) throw error;
      await links.refresh(true);
      const current = linkedDiscordId(state.principalId);
      return finish(res, current && current !== user.id ? "already_linked" : "linked_elsewhere");
    }
    await deps.identity?.refresh(true);
    audit(deps, {
      principalId: state.principalId,
      action: "discord_link.create",
      resource: `${alias} -> ${state.principalId}`,
      scopeLabel: state.principalId,
    });
    return finish(res, "connected");
  } catch {
    return finish(res, "failed");
  }
}

async function discordUnlink(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const principal = signedInPrincipal(ctx);
  if (!principal) return;
  if (!deps.principalLinks) return sendJson(res, 404, { error: "not_found" });
  await deps.principalLinks.refresh(true);
  const discordId = linkedDiscordId(principal);
  const link = discordId
    ? await unlinkDiscordAccount(
        { links: deps.principalLinks, identity: deps.identity, auditLog: deps.auditLog },
        discordId,
        principal,
      )
    : null;
  if (!link) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { ok: true });
}

export const discordLinkRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { match: (m, p) => m === "GET" && p === DISCORD_LINK_CALLBACK_PATH, auth: "public", handle: discordLinkCallback },
];

export const discordLinkRoutes: ReadonlyArray<Route> = [
  { method: "GET", path: "/v1/discord-link", auth: "source", handle: discordLinkStatus },
  { method: "GET", path: "/v1/discord-link/start", auth: "source", handle: discordLinkStart },
  { method: "DELETE", path: "/v1/discord-link", auth: "source", handle: discordUnlink },
];
