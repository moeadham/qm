import "./support/auto-fake-sprites.ts";

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { mintDiscordLinkTicket } from "../src/identity/discord-link.ts";
import { orgId } from "../src/config.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "discord-link-route-test-secret".repeat(2);
const JORDAN = "jordan@acme.test";
const CASEY = "casey@acme.test";
const DISCORD_A = "111111111111111111";
const DISCORD_B = "222222222222222222";

function fakeDiscord(userId: () => string, tokenStatus: () => number): Server {
  const server = createHttpServer((req, res) => {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = decodeURIComponent(req.url ?? "");
    if (req.method === "POST" && path === "/v10/oauth2/token")
      return tokenStatus() === 200
        ? reply(200, { access_token: "discord-at", token_type: "Bearer", expires_in: 604800, scope: "identify" })
        : reply(tokenStatus(), { error: "invalid_grant" });
    if (req.method === "GET" && path === "/v10/users/@me" && req.headers.authorization === "Bearer discord-at")
      return reply(200, { id: userId(), username: "jordo" });
    return reply(404, { message: "Unknown route", code: 0 });
  });
  server.listen(0);
  return server;
}

const urlOf = (server: Server): string => `http://localhost:${(server.address() as AddressInfo).port}`;

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

function start(
  discordUser: () => string,
  tokenStatus: () => number = () => 200,
): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const discord = fakeDiscord(discordUser, tokenStatus);
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "discord-link-")) }));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: built.replayDedupe,
    oauthFlows: built.oauthFlows,
    auditLog: built.auditLog,
    identity: built.identity,
    principalLinks: built.principalLinks,
    portalUrl: "https://qm.example.test",
    oauthEnv: { DISCORD_APPLICATION_ID: "app-1", DISCORD_CLIENT_SECRET: "app-secret" } as NodeJS.ProcessEnv,
    discordApiUrl: urlOf(discord),
  });
  server.listen(0);
  return {
    base: urlOf(server),
    built,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => discord.close(() => r()));
      installPrincipalLinks(null);
    },
  };
}

async function startLink(srv: { base: string }, principal: string, ticketFor?: string): Promise<string> {
  const qs = ticketFor ? `?t=${encodeURIComponent(await mintDiscordLinkTicket(ticketFor, orgId(), SECRET))}` : "";
  const startPath = `/v1/discord-link/start${qs}`;
  const startRes = await fetch(`${srv.base}${startPath}`, { headers: await headers("GET", startPath, principal) });
  assert.equal(startRes.status, 200, await startRes.clone().text());
  const authorize = new URL(((await startRes.json()) as { authorizeUrl: string }).authorizeUrl);
  assert.equal(authorize.searchParams.get("scope"), "identify");
  assert.equal(authorize.searchParams.get("client_id"), "app-1");
  assert.equal(authorize.searchParams.get("redirect_uri"), "https://qm.example.test/v1/discord-link/callback");
  return authorize.searchParams.get("state")!;
}

async function callback(
  srv: { base: string },
  state: string,
  browserPrincipal?: string,
): Promise<{ status: number; location: string | null }> {
  const res = await fetch(`${srv.base}/v1/discord-link/callback?code=c1&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
    headers: browserPrincipal
      ? { "x-portal-identity": await mintSignedPayload({ p: browserPrincipal, exp: Date.now() + 60_000 }, SECRET) }
      : {},
  });
  return { status: res.status, location: res.headers.get("location") };
}

async function linkAs(
  srv: { base: string },
  principal: string,
  ticketFor?: string,
): Promise<{ status: number; location: string | null }> {
  return callback(srv, await startLink(srv, principal, ticketFor), principal);
}

test("a signed-in QM user links the Discord account they prove with OAuth, and can unlink it", async () => {
  const srv = start(() => DISCORD_A);
  try {
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_A}`).type, "guest");
    const linked = await linkAs(srv, JORDAN, DISCORD_A);
    assert.equal(linked.status, 302);
    assert.match(linked.location ?? "", /^\/settings\?discord=connected/);
    assert.deepEqual(srv.built.identity.classify(`discord:${DISCORD_A}`), { id: JORDAN, type: "internal" });

    const statusRes = await fetch(`${srv.base}/v1/discord-link`, {
      headers: await headers("GET", "/v1/discord-link", JORDAN),
    });
    const status = (await statusRes.json()) as Record<string, unknown>;
    assert.equal(typeof status.linkedAt, "number");
    assert.deepEqual(
      { ...status, linkedAt: 0 },
      { configured: true, linked: true, discordId: DISCORD_A, username: "jordo", linkedAt: 0 },
    );

    const unlink = await fetch(`${srv.base}/v1/discord-link`, {
      method: "DELETE",
      headers: await headers("DELETE", "/v1/discord-link", JORDAN),
    });
    assert.equal(unlink.status, 200);
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_A}`).type, "guest");
    const afterUnlink = await fetch(`${srv.base}/v1/discord-link`, {
      headers: await headers("GET", "/v1/discord-link", JORDAN),
    });
    assert.deepEqual(await afterUnlink.json(), { configured: true, linked: false });
  } finally {
    await srv.close();
  }
});

test("a link prompt forwarded to someone else cannot bind a different Discord account", async () => {
  const srv = start(() => DISCORD_B);
  try {
    const result = await linkAs(srv, JORDAN, DISCORD_A);
    assert.match(result.location ?? "", /^\/settings\?discord=wrong_account/);
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_A}`).type, "guest");
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_B}`).type, "guest");
  } finally {
    await srv.close();
  }
});

test("a Discord account already linked to another QM user stays with them", async () => {
  const srv = start(() => DISCORD_A);
  try {
    assert.match((await linkAs(srv, CASEY)).location ?? "", /^\/settings\?discord=connected/);
    assert.match((await linkAs(srv, JORDAN)).location ?? "", /^\/settings\?discord=linked_elsewhere/);
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_A}`).id, CASEY);
  } finally {
    await srv.close();
  }
});

test("linking requires a portal-signed QM session and a single-use state", async () => {
  const srv = start(() => DISCORD_A);
  try {
    const anonymous = await fetch(`${srv.base}/v1/discord-link/start`, {
      headers: await headers("GET", "/v1/discord-link/start"),
    });
    assert.equal(anonymous.status, 403);

    const state = await startLink(srv, JORDAN);
    assert.match((await callback(srv, state, JORDAN)).location ?? "", /^\/settings\?discord=connected/);
    assert.match((await callback(srv, state, JORDAN)).location ?? "", /^\/settings\?discord=failed/);
  } finally {
    await srv.close();
  }
});

test("an authorize URL handed to someone else cannot finish in their browser", async () => {
  const srv = start(() => DISCORD_B);
  try {
    assert.match(
      (await callback(srv, await startLink(srv, JORDAN), CASEY)).location ?? "",
      /^\/settings\?discord=wrong_session/,
    );
    assert.match(
      (await callback(srv, await startLink(srv, JORDAN))).location ?? "",
      /^\/settings\?discord=wrong_session/,
    );
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_B}`).type, "guest");
  } finally {
    await srv.close();
  }
});

test("a QM user keeps one Discord account until they unlink it", async () => {
  let discordUser = DISCORD_A;
  const srv = start(() => discordUser);
  try {
    assert.match((await linkAs(srv, JORDAN)).location ?? "", /^\/settings\?discord=connected/);
    discordUser = DISCORD_B;
    assert.match((await linkAs(srv, JORDAN)).location ?? "", /^\/settings\?discord=already_linked/);
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_B}`).type, "guest");
  } finally {
    await srv.close();
  }
});

test("a rejected Discord code fails the link and reports why", async () => {
  const srv = start(
    () => DISCORD_A,
    () => 400,
  );
  const errors = mock.method(console, "error", () => {});
  try {
    assert.match((await linkAs(srv, JORDAN)).location ?? "", /^\/settings\?discord=failed/);
    assert.equal(errors.mock.callCount(), 1);
    assert.equal(srv.built.identity.classify(`discord:${DISCORD_A}`).type, "guest");
  } finally {
    errors.mock.restore();
    await srv.close();
  }
});
