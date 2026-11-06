import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";
import { DISCORD_PRINCIPAL_PREFIX as ALIAS_PREFIX, personIds } from "../directory/person.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { PrincipalLink, PrincipalLinkService } from "./principal-links.ts";

const SNOWFLAKE = /^\d{15,22}$/;
const TICKET_TTL_MS = 30 * 60_000;
const DISCORD_API = "https://discord.com/api/v10";

export const DISCORD_LINK_PROVIDER = "discord-link";
export const DISCORD_LINK_CALLBACK_PATH = "/v1/discord-link/callback";

export function discordAlias(userId: string): string {
  if (!SNOWFLAKE.test(userId)) throw new Error("invalid Discord user id");
  return `${ALIAS_PREFIX}${userId}`;
}

export function linkedDiscordId(principalId: string): string | undefined {
  for (const id of personIds(principalId)) {
    if (!id.toLowerCase().startsWith(ALIAS_PREFIX)) continue;
    const userId = id.slice(ALIAS_PREFIX.length);
    if (SNOWFLAKE.test(userId)) return userId;
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
    !SNOWFLAKE.test(claims.discordId)
  )
    return null;
  return claims.discordId;
}

export type DiscordFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface DiscordOAuthClient {
  id: string;
  secret: string;
}

export function discordAuthorizeUrl(opts: {
  client: DiscordOAuthClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const q = new URLSearchParams({
    client_id: opts.client.id,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: "identify",
    state: opts.state,
    prompt: "consent",
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://discord.com/oauth2/authorize?${q.toString()}`;
}

export async function verifiedDiscordUser(opts: {
  client: DiscordOAuthClient;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchImpl: DiscordFetch;
}): Promise<{ id: string; username: string }> {
  const tokenRes = await opts.fetchImpl(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.client.id,
      client_secret: opts.client.secret,
      code_verifier: opts.codeVerifier,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`Discord token exchange failed (${tokenRes.status})`);
  const token = (await tokenRes.json()) as { access_token?: unknown };
  if (typeof token.access_token !== "string" || !token.access_token)
    throw new Error("Discord token exchange returned no access token");
  const userRes = await opts.fetchImpl(`${DISCORD_API}/users/@me`, {
    method: "GET",
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) throw new Error(`Discord user lookup failed (${userRes.status})`);
  const user = (await userRes.json()) as { id?: unknown; username?: unknown; bot?: unknown };
  if (typeof user.id !== "string" || !SNOWFLAKE.test(user.id) || user.bot === true)
    throw new Error("Discord returned an unusable user");
  return { id: user.id, username: typeof user.username === "string" ? user.username : user.id };
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
