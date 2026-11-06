import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const SECRET = "discord-link-route-test";
const calls: Array<{ method: string; url: string; identity: string | undefined }> = [];
const core = createServer((req, res) => {
  const identity = req.headers[PORTAL_IDENTITY_HEADER];
  calls.push({
    method: req.method ?? "GET",
    url: req.url ?? "",
    identity: typeof identity === "string" ? identity : undefined,
  });
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify(
      req.method === "DELETE" ? { ok: true } : { configured: true, linked: true, discordId: "1", username: "alice_d" },
    ),
  );
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const identity = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET);

test.after(() => {
  surface.close();
  core.close();
});

test("the Discord link status and unlink relay to core as the signed-in user", async () => {
  const status = await fetch(`${base}/api/discord-link`, { headers: { [PORTAL_IDENTITY_HEADER]: identity } });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { configured: true, linked: true, discordId: "1", username: "alice_d" });

  const unlink = await fetch(`${base}/api/discord-link`, {
    method: "DELETE",
    headers: { [PORTAL_IDENTITY_HEADER]: identity },
  });
  assert.equal(unlink.status, 200);

  const relayed = calls.filter((c) => c.url.startsWith("/v1/discord-link"));
  assert.deepEqual(
    relayed.map((c) => [c.method, c.url.split("?")[0], c.identity]),
    [
      ["GET", "/v1/discord-link", identity],
      ["DELETE", "/v1/discord-link", identity],
    ],
  );
});
