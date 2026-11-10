import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageType } from "@discordjs/core";
import { createDiscordContextFulfiller } from "../src/discord/context.ts";
import type { DiscordMessage } from "../src/discord/api.ts";
import type { SurfaceContextQuery, SurfaceContextResult } from "../src/types.ts";

const msg = (id: string, content: string, extra: Partial<DiscordMessage> = {}): DiscordMessage =>
  ({
    id,
    channel_id: "thread-1",
    content,
    timestamp: new Date().toISOString(),
    mentions: [],
    type: 0,
    author: { id: "u1", username: "alice", global_name: null },
    ...extra,
  }) as DiscordMessage;

function setup(history: DiscordMessage[]) {
  const pages: Array<string | undefined> = [];
  const outcomes: Array<{ result?: SurfaceContextResult; error?: string }> = [];
  const sorted = [...history].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  const fulfill = createDiscordContextFulfiller({
    api: {
      async recentMessages(_channel, limit, before) {
        pages.push(before);
        const start = before ? sorted.findIndex((m) => m.id === before) + 1 : 0;
        return sorted.slice(start, start + limit);
      },
      async message(_channel, id) {
        const found = history.find((m) => m.id === id);
        if (!found) throw new Error("Unknown Message");
        return found;
      },
    },
    core: {
      async fulfillContextRequest(_id, outcome) {
        outcomes.push(outcome);
      },
      async stageBlob(bytes) {
        return { blobId: `blob-${bytes.length}`, sizeBytes: bytes.length };
      },
    },
    selfId: "bot",
    fetchImpl: (async () => new Response("FILEBYTES")) as unknown as typeof fetch,
  });
  const ask = async (query: SurfaceContextQuery) => {
    await fulfill({ id: "r", source: "discord", createdAt: Date.now(), status: "pending", query });
    return outcomes.at(-1)!;
  };
  return { ask, pages };
}

test("search scans past the first page of Discord history and returns only matches", async () => {
  const history = Array.from({ length: 150 }, (_, i) =>
    msg(String(900000000000000000n + BigInt(i)), i === 5 ? "the deploy key rotated" : `chatter ${i}`),
  );
  const { ask, pages } = setup(history);
  const out = await ask({ conversationTarget: "thread-1", match: "deploy key", count: 100 });
  const messages = out.result!.messages as Array<{ ts: string; text: string; threadTs: string }>;
  assert.deepEqual(
    messages.map((m) => m.text),
    ["the deploy key rotated"],
  );
  assert.equal(messages[0]!.threadTs, "thread-1", "every message belongs to this conversation");
  assert.equal(pages.length, 2, "followed the cursor to the second page");
});

test("a file on a named message is fetched and staged", async () => {
  const { ask } = setup([
    msg("900000000000000001", "here", {
      attachments: [
        { id: "a1", filename: "notes.txt", size: 9, url: "https://cdn.discordapp.com/attachments/1/2/notes.txt" },
      ],
    }),
  ]);
  const out = await ask({ conversationTarget: "thread-1", file: { ts: "900000000000000001", name: "notes.txt" } });
  assert.deepEqual(out.result?.file, {
    blobId: "blob-9",
    name: "notes.txt",
    mimetype: "application/octet-stream",
    sizeBytes: 9,
    author: "alice",
  });
});

test("requests Discord can't serve get a clear answer instead of a timeout", async () => {
  const { ask } = setup([]);
  assert.match((await ask({ channelName: "general" })).error ?? "", /other channels/);
  assert.match((await ask({ conversationTarget: "thread-1", searchAll: "x" })).error ?? "", /isn't supported/);
  assert.match(
    (await ask({ conversationTarget: "thread-1", file: { ts: "900000000000000099" } })).error ?? "",
    /Discord read failed/,
  );
});

test("reading the conversation leaves out Discord system events like a thread rename", async () => {
  const { ask } = setup([
    msg("900000000000000001", "can you check CI"),
    msg("900000000000000002", "CI", { type: MessageType.ChannelNameChange }),
    msg("900000000000000003", "thanks", { type: MessageType.Reply }),
  ]);
  const out = await ask({ conversationTarget: "thread-1", count: 10 });
  assert.deepEqual(
    (out.result!.messages as Array<{ text: string }>).map((m) => m.text),
    ["can you check CI", "thanks"],
  );
});
