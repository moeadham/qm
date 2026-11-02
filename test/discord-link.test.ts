import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import type { FetchLike } from "../src/connectors/oauth.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { mintDiscordLinkTicket } from "../src/identity/discord-link.ts";
import { orgId } from "../src/config.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "discord-link-route-test-secret".repeat(2);
const JORDAN = "jordan@acme.test";
const CASEY = "casey@acme.test";
const DISCORD_A = "111111111111111111";
const DISCORD_B = "222222222222222222";

function discordApi(userId: () => string): FetchLike {
  return async (url) => {
    if (url.endsWith("/oauth2/token"))
      return { ok: true, status: 200, json: async () => ({ access_token: "discord-at" }) };
    if (url.endsWith("/users/@me"))
      return { ok: true, status: 200, json: async () => ({ id: userId(), username: "jordo" }) };
    throw new Error(`unexpected Discord call ${url}`);
  };
}

async function headers(method: string, path: string, principal?: string): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${path}\n`),
    ...(principal
      ? { "x-portal-identity": await mintSignedPayload({ p: principal, exp: Date.now() + 60_000 }, SECRET) }
      : {}),
  };
}

function start(discordUser: () => string): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "discord-link-")) }));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: built.replayDedupe,
    oauthFlows: built.oauthFlows,
    auditLog: built.auditLog,
    identity: built.identity,
    principalLinks: built.principalLinks,
    oauthEnv: { DISCORD_APPLICATION_ID: "app-1", DISCORD_CLIENT_SECRET: "app-secret" } as NodeJS.ProcessEnv,
    oauthFetch: discordApi(discordUser),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    base,
    built,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      installPrincipalLinks(null);
    },
  };
}

async function linkAs(
  srv: { base: string },
  principal: string,
  ticketFor?: string,
): Promise<{ status: number; location: string | null }> {
  const redirectUri = `${srv.base}/v1/discord-link/callback`;
  const qs = new URLSearchParams({ redirectUri });
  if (ticketFor) qs.set("t", await mintDiscordLinkTicket(ticketFor, orgId(), SECRET));
  const startPath = `/v1/discord-link/start?${qs.toString()}`;
  const startRes = await fetch(`${srv.base}${startPath}`, { headers: await headers("GET", startPath, principal) });
  assert.equal(startRes.status, 200, await startRes.clone().text());
  const authorize = new URL(((await startRes.json()) as { authorizeUrl: string }).authorizeUrl);
  assert.equal(authorize.searchParams.get("scope"), "identify");
  assert.equal(authorize.searchParams.get("client_id"), "app-1");
  const state = authorize.searchParams.get("state")!;
  const callback = await fetch(
    `${srv.base}/v1/discord-link/callback?code=c1&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
  );
  return { status: callback.status, location: callback.headers.get("location") };
}

test("a signed-in QM user links the Discord account they prove with OAuth, and can unlink it", async () => {
  const srv = start(() => DISCORD_A);
  try {
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_A}`).type, "guest");
    const linked = await linkAs(srv, JORDAN, DISCORD_A);
    assert.equal(linked.status, 302);
    assert.match(linked.location ?? "", /status=connected/);
    assert.deepEqual(srv.built.identity.classify(`discord:${DISCORD_A}`), { id: JORDAN, type: "internal" });

    const statusRes = await fetch(`${srv.base}/v1/discord-link`, {
      headers: await headers("GET", "/v1/discord-link", JORDAN),
    });
    assert.deepEqual(await statusRes.json(), { configured: true, linked: true, discordId: DISCORD_A });

    const unlink = await fetch(`${srv.base}/v1/discord-link`, {
      method: "DELETE",
      headers: await headers("DELETE", "/v1/discord-link", JORDAN),
    });
    assert.equal(unlink.status, 200);
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_A}`).type, "guest");
  } finally {
    await srv.close();
  }
});

test("a link prompt forwarded to someone else cannot bind a different Discord account", async () => {
  const srv = start(() => DISCORD_B);
  try {
    const result = await linkAs(srv, JORDAN, DISCORD_A);
    assert.match(result.location ?? "", /status=wrong_account/);
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_A}`).type, "guest");
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_B}`).type, "guest");
  } finally {
    await srv.close();
  }
});

test("a Discord account already linked to another QM user stays with them", async () => {
  const srv = start(() => DISCORD_A);
  try {
    assert.match((await linkAs(srv, CASEY)).location ?? "", /status=connected/);
    assert.match((await linkAs(srv, JORDAN)).location ?? "", /status=linked_elsewhere/);
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_A}`).id, CASEY);
  } finally {
    await srv.close();
  }
});

test("linking requires a portal-signed QM session and a single-use state", async () => {
  const srv = start(() => DISCORD_A);
  try {
    const startPath = `/v1/discord-link/start?redirectUri=${encodeURIComponent(`${srv.base}/v1/discord-link/callback`)}`;
    const anonymous = await fetch(`${srv.base}${startPath}`, { headers: await headers("GET", startPath) });
    assert.equal(anonymous.status, 403);

    const startRes = await fetch(`${srv.base}${startPath}`, { headers: await headers("GET", startPath, JORDAN) });
    const state = new URL(((await startRes.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get("state")!;
    const callbackPath = `/v1/discord-link/callback?code=c1&state=${encodeURIComponent(state)}`;
    assert.equal((await fetch(`${srv.base}${callbackPath}`, { redirect: "manual" })).status, 302);
    const replay = await fetch(`${srv.base}${callbackPath}`, { redirect: "manual" });
    assert.equal(replay.status, 400);
  } finally {
    await srv.close();
  }
});
