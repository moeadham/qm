import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveKey, seal } from "../src/session.ts";
import { PORTAL_IDENTITY_HEADER, verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";

const identitySecret = "discord-link-portal-identity-secret-32+";
const seen: Array<{ path: string; principal: string | null }> = [];
const core = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://core.test");
  if (url.pathname !== "/v1/discord-link/callback") {
    res.setHeader("content-type", "application/json");
    return void res.end("{}");
  }
  const header = req.headers[PORTAL_IDENTITY_HEADER];
  const actor = typeof header === "string" ? verifyPortalIdentity(header, identitySecret, Date.now()) : null;
  seen.push({ path: `${url.pathname}${url.search}`, principal: actor?.p ?? null });
  res.writeHead(302, { location: "/settings?discord=connected" });
  res.end();
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const sessionSecret = "discord-link-session-secret-at-least-32";
Object.assign(process.env, {
  PORTAL_PUBLIC_URL: "http://portal.test",
  PORTAL_SESSION_SECRET: sessionSecret,
  CORE_SIGNING_SECRET: "discord-link-core-signing-secret-32chars",
  PORTAL_IDENTITY_SECRET: identitySecret,
  CORE_API_URL: `http://127.0.0.1:${(core.address() as AddressInfo).port}`,
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  core.close();
});

const callbackPath = "/v1/discord-link/callback?code=c1&state=s1";

test("the Discord link callback sends a signed-out browser to log in and keeps the code", async () => {
  const before = seen.length;
  const r = await fetch(`${base}${callbackPath}`, { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), `/auth/login?returnTo=${encodeURIComponent(callbackPath)}`);
  assert.equal(seen.length, before);
});

test("the Discord link callback forwards the browser's own session, never a client-supplied identity", async () => {
  const now = Math.floor(Date.now() / 1000);
  const session = seal(
    { k: "session", sub: "eve@acme", org: "acme", iat: now, exp: now + 3600 },
    deriveKey(sessionSecret, "portal.session.v1"),
  );
  const r = await fetch(`${base}${callbackPath}`, {
    headers: { cookie: `portal_session=${encodeURIComponent(session)}`, [PORTAL_IDENTITY_HEADER]: "forged" },
    redirect: "manual",
  });
  assert.equal(r.status, 302);
  assert.deepEqual(seen.at(-1), { path: callbackPath, principal: "eve@acme" });
});
