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

test("Settings shows the linked Discord account after the OAuth return and can unlink it", async () => {
  let linked = true;
  const deletes: string[] = [];
  const h = await harness({
    path: "/settings?discord=connected",
    api: (path, init) => {
      if (path !== "/api/discord-link") return undefined;
      if (init?.method === "DELETE") {
        deletes.push(path);
        linked = false;
        return Response.json({ ok: true });
      }
      return Response.json(
        linked
          ? {
              configured: true,
              linked: true,
              discordId: "123456789012345678",
              username: "moe",
              linkedAt: Date.UTC(2026, 10, 4),
            }
          : { configured: true, linked: false },
      );
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await waitFor(() => /Your Discord account is linked/.test(card()?.textContent ?? ""));
    const status = card()!.querySelector<HTMLElement>(".slack-connected[role=status]");
    assert.match(status?.textContent ?? "", /Your Discord account is linked · @moe · linked .*2026/);
    assert.match(card()!.textContent ?? "", /The QM bot now accepts your messages/);
    assert.equal(new URL(location.href).searchParams.get("discord"), null);

    Object.assign(window, { confirm: () => true });
    const unlink = [...card()!.querySelectorAll("button")].find((b) => /Unlink/.test(b.textContent ?? ""));
    unlink!.click();
    await waitFor(() => /Link your Discord account/.test(card()?.textContent ?? ""));
    assert.equal(deletes.length, 1);
    assert.match(card()!.textContent ?? "", /Discord unlinked/);
    assert.equal(card()!.querySelector("a.welcome-slack")?.getAttribute("href"), "/connect/discord");
  } finally {
    await h.close();
  }
});
