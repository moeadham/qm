import assert from "node:assert/strict";
import { test } from "node:test";
import { isDiscordFileUrl, sendDiscordFiles } from "../src/discord/files.ts";

test("files are split so no single Discord message goes over the upload limit", async () => {
  const sent: string[][] = [];
  const big = Buffer.alloc(6 * 1024 * 1024);
  const blobs = { readBlob: async () => big, readFileArtifact: async () => big };
  const file = (name: string) => ({ name, mimetype: "application/octet-stream", sizeBytes: big.length, blobId: name });
  const problems = await sendDiscordFiles(
    { sendFiles: async (_channel, files) => (sent.push(files.map((f) => f.name)), "m") },
    blobs,
    "c1",
    [file("a"), file("b"), file("c")],
    { key: "k" },
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(sent, [["a"], ["b"], ["c"]]);
});

test("only https Discord file hosts are fetched", () => {
  assert.equal(isDiscordFileUrl("https://cdn.discordapp.com/attachments/1/2/a.png"), true);
  assert.equal(isDiscordFileUrl("https://media.discordapp.net/attachments/1/2/a.png"), true);
  assert.equal(isDiscordFileUrl("http://cdn.discordapp.com/a.png"), false);
  assert.equal(isDiscordFileUrl("https://cdn.discordapp.com.evil.example/a.png"), false);
  assert.equal(isDiscordFileUrl("https://evil.example/?u=https://cdn.discordapp.com/a.png"), false);
});
