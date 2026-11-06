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

test("a failed Discord link return explains the failure in Settings", async () => {
  const h = await harness({
    path: "/settings?discord=linked_elsewhere",
    api: (path) => (path === "/api/discord-link" ? Response.json({ configured: true, linked: false }) : undefined),
  });
  try {
    h.releaseSessions();
    await h.boot();
    await waitFor(() => /Link your Discord account/.test(card()?.textContent ?? ""));
    assert.match(card()!.textContent ?? "", /linked to another QM user/);
  } finally {
    await h.close();
  }
});
