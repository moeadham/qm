import { orgId as configOrgId } from "../../config.ts";
import { codeChallengeS256, generateCodeVerifier } from "../../connectors/oauth.ts";
import { createEnvSecretSource } from "../../credentials/secret-source.ts";
import { PrincipalLinkError } from "../../identity/principal-links.ts";
import {
  DISCORD_LINK_CALLBACK_PATH,
  DISCORD_LINK_PROVIDER,
  discordAlias,
  discordAuthorizeUrl,
  linkedDiscordId,
  verifiedDiscordUser,
  verifyDiscordLinkTicket,
  type DiscordFetch,
  type DiscordOAuthClient,
} from "../../identity/discord-link.ts";
import { errMessage } from "../../util/errors.ts";
import type { ServerDeps } from "../deps.ts";
import { sendJson, sendRedirect } from "../http.ts";
import { OAUTH_STATE_MAX_AGE_MS, beginOAuthFlow, resumeOAuthFlow } from "./connectors.ts";
import { activePrincipal, audit } from "./shared.ts";
import type { ApiCtx, BaseCtx, Route } from "./route.ts";

const RETURN_TO = "/connectors";

async function discordClient(deps: ServerDeps): Promise<DiscordOAuthClient | null> {
  const env = createEnvSecretSource(deps.oauthEnv);
  const [id, secret] = await Promise.all([env.get("DISCORD_APPLICATION_ID"), env.get("DISCORD_CLIENT_SECRET")]);
  return id && secret ? { id, secret } : null;
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

function finish(res: BaseCtx["res"], status: string, detail?: string): void {
  const dest = new URLSearchParams({ connector: "discord", status, ...(detail ? { detail } : {}) });
  return sendRedirect(res, `${RETURN_TO}?${dest.toString()}`);
}

async function discordLinkStatus(ctx: ApiCtx): Promise<void> {
  const principal = signedInPrincipal(ctx);
  if (!principal) return;
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
  if (!client)
    return sendJson(res, 501, {
      error: "not_configured",
      message: "Discord linking isn't set up — set DISCORD_APPLICATION_ID and DISCORD_CLIENT_SECRET.",
    });
  const redirectUri = url.searchParams.get("redirectUri") ?? "";
  if (!redirectUri.endsWith(DISCORD_LINK_CALLBACK_PATH))
    return sendJson(res, 400, { error: "bad_request", message: `redirectUri must end with ${DISCORD_LINK_CALLBACK_PATH}` });
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
    principalId: principal,
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
  if (!code || !stateParam) return sendJson(res, 400, { error: "bad_request", message: "code and state required" });
  const links = deps.principalLinks;
  if (!links) return sendJson(res, 501, { error: "not_configured", message: "principal links not wired" });
  try {
    const state = await resumeOAuthFlow(deps, secret, stateParam);
    if (state.provider !== DISCORD_LINK_PROVIDER || state.orgId !== configOrgId() || !state.codeVerifier)
      throw new Error("Discord link state is invalid");
    if (
      !deps.replayDedupe ||
      !(await deps.replayDedupe.claim(`oauth:${state.nonce}`, state.issuedAt + OAUTH_STATE_MAX_AGE_MS))
    )
      throw new Error("Discord link state was already used");
    const client = await discordClient(deps);
    if (!client) throw new Error("Discord linking isn't configured");
    const user = await verifiedDiscordUser({
      client,
      code,
      redirectUri: state.redirectUri,
      codeVerifier: state.codeVerifier,
      fetchImpl: discordFetch(deps),
    });
    if (state.subject && state.subject !== user.id) return finish(res, "wrong_account");
    if (!(await activePrincipal(deps, state.principalId))) return finish(res, "inactive");
    const existing = linkedDiscordId(state.principalId);
    if (existing && existing !== user.id) return finish(res, "already_linked");
    const alias = discordAlias(user.id);
    const link = await links.link({
      principalId: alias,
      canonicalId: state.principalId,
      evidence: `Discord OAuth user ${user.id} (${user.username})`,
      linkedBy: state.principalId,
    });
    await deps.identity?.refresh(true);
    audit(deps, {
      principalId: state.principalId,
      action: "discord_link.create",
      resource: `${alias} -> ${link.canonicalId}`,
      scopeLabel: state.principalId,
    });
    return finish(res, "connected");
  } catch (error) {
    if (error instanceof PrincipalLinkError && error.status === 409) return finish(res, "linked_elsewhere");
    return sendJson(res, 400, { error: "discord_link_failed", message: errMessage(error) });
  }
}

async function discordUnlink(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const principal = signedInPrincipal(ctx);
  if (!principal) return;
  const discordId = linkedDiscordId(principal);
  if (!discordId || !deps.principalLinks) return sendJson(res, 404, { error: "not_found" });
  const link = await deps.principalLinks.unlink(discordAlias(discordId));
  if (!link) return sendJson(res, 404, { error: "not_found" });
  await deps.identity?.refresh(true);
  audit(deps, {
    principalId: principal,
    action: "discord_link.delete",
    resource: `${link.principalId} -> ${link.canonicalId}`,
    scopeLabel: principal,
  });
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
