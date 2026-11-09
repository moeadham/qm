import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check());
}

function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>("qm-discord-account");
}

test("Settings hides the Discord row when Discord linking is not configured", async () => {
  const h = await harness({
    path: "/settings",
    api: (path) => (path === "/api/discord-link" ? Response.json({ configured: false, linked: false }) : undefined),
  });
  try {
    h.releaseSessions();
    await h.boot();
    await waitFor(() => h.requests.includes("/api/discord-link"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(card()!.hidden, true);
    assert.doesNotMatch(card()!.textContent ?? "", /Discord/);
  } finally {
    await h.close();
  }
});
