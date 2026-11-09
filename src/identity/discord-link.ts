import { API } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";
import { DISCORD_PRINCIPAL_PREFIX as ALIAS_PREFIX, personIds } from "../directory/person.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { PrincipalLink, PrincipalLinkService } from "./principal-links.ts";
import { isDiscordSnowflake } from "../util/message-tag.ts";

const TICKET_TTL_MS = 30 * 60_000;

export const DISCORD_LINK_PROVIDER = "discord-link";
export const DISCORD_LINK_CALLBACK_PATH = "/v1/discord-link/callback";

export function discordAlias(userId: string): string {
  if (!isDiscordSnowflake(userId)) throw new Error("invalid Discord user id");
  return `${ALIAS_PREFIX}${userId}`;
}

export function linkedDiscordId(principalId: string): string | undefined {
  for (const id of personIds(principalId)) {
    if (!id.toLowerCase().startsWith(ALIAS_PREFIX)) continue;
    const userId = id.slice(ALIAS_PREFIX.length);
    if (isDiscordSnowflake(userId)) return userId;
  }
  return undefined;
}

export function mintDiscordLinkTicket(
  discordId: string,
  org: string,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  discordAlias(discordId);
  return mintSignedPayload({ purpose: "discord-link", org, discordId, exp: now + TICKET_TTL_MS }, secret);
}

export async function verifyDiscordLinkTicket(
  ticket: string,
  org: string,
  secret: string,
  now: number = Date.now(),
): Promise<string | null> {
  const claims = (await verifySignedPayload(ticket, secret)) as Record<string, unknown> | null;
  if (
    !claims ||
    claims.purpose !== "discord-link" ||
    claims.org !== org ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    typeof claims.discordId !== "string" ||
    !isDiscordSnowflake(claims.discordId)
  )
    return null;
  return claims.discordId;
}

export interface DiscordOAuthClient {
  id: string;
  secret: string;
}

function oauthApi(apiUrl?: string): { api: API; rest: REST } {
  const rest = new REST({
    authPrefix: "Bearer",
    hashSweepInterval: 0,
    handlerSweepInterval: 0,
    ...(apiUrl ? { api: apiUrl } : {}),
  });
  return { api: new API(rest), rest };
}

export function discordAuthorizeUrl(opts: {
  client: DiscordOAuthClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const query = {
    client_id: opts.client.id,
    redirect_uri: opts.redirectUri,
    response_type: "code" as const,
    scope: "identify",
    state: opts.state,
    prompt: "consent" as const,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  };
  return oauthApi().api.oauth2.generateAuthorizationURL(query);
}

export async function verifiedDiscordUser(opts: {
  client: DiscordOAuthClient;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  apiUrl?: string;
}): Promise<{ id: string; username: string }> {
  const { api, rest } = oauthApi(opts.apiUrl);
  const exchange = {
    grant_type: "authorization_code" as const,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.client.id,
    client_secret: opts.client.secret,
    code_verifier: opts.codeVerifier,
  };
  const token = await api.oauth2.tokenExchange(exchange);
  rest.setToken(token.access_token);
  const user = await api.users.getCurrent();
  if (!isDiscordSnowflake(user.id) || user.bot === true) throw new Error("Discord returned an unusable user");
  return { id: user.id, username: user.username };
}

export async function unlinkDiscordAccount(
  deps: {
    links: Pick<PrincipalLinkService, "unlink">;
    identity?: { refresh(force?: boolean): Promise<void> };
    auditLog?: Pick<AuditLog, "record">;
  },
  discordId: string,
  actor: string,
): Promise<PrincipalLink | null> {
  const link = await deps.links.unlink(discordAlias(discordId));
  if (!link) return null;
  await deps.identity?.refresh(true);
  deps.auditLog?.record({
    at: Date.now(),
    principalId: actor,
    action: "discord_link.delete",
    resource: `${link.principalId} -> ${link.canonicalId}`,
    scopeLabel: actor,
  });
  return link;
}
