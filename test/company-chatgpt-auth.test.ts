import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatgptAuthFromValue } from "../src/model/chatgpt-auth-file.ts";
import { fileCompanyChatGPTAuth } from "../src/model/company-chatgpt-auth.ts";

function jwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(payload)}.sig`;
}

function idToken(accountId: string): string {
  return jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

function accessToken(accountId: string, expSec: number, marker = "a"): string {
  return jwt({ exp: expSec, marker, "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

function authJson(accountId: string, expSec: number, refreshToken = "refresh-1"): Record<string, unknown> {
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: accessToken(accountId, expSec),
      refresh_token: refreshToken,
      id_token: idToken(accountId),
      account_id: accountId,
    },
  };
}

const NOW = 1_900_000_000_000;
const FRESH_EXP = Math.floor(NOW / 1000) + 3600;
const STALE_EXP = Math.floor(NOW / 1000) + 60;

test("chatgptAuthFromValue validates shape and account binding", () => {
  assert.ok(chatgptAuthFromValue(authJson("acct", FRESH_EXP)));
  assert.equal(chatgptAuthFromValue({ auth_mode: "apikey" }), null);
  const missingRefresh = authJson("acct", FRESH_EXP);
  delete (missingRefresh.tokens as Record<string, unknown>).refresh_token;
  assert.equal(chatgptAuthFromValue(missingRefresh), null);
});

test("file auth serves the local login as-is and never refreshes or rewrites it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-chatgpt-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.json");
  const stored = JSON.stringify(authJson("acct", STALE_EXP, "refresh-1"));
  writeFileSync(path, stored);
  chmodSync(path, 0o600);
  const fetches = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 500 }));
  const auth = fileCompanyChatGPTAuth(path);
  assert.equal(await auth.accessToken(), accessToken("acct", STALE_EXP));
  assert.equal(fetches.mock.callCount(), 0);
  assert.equal(readFileSync(path, "utf8"), stored);
  chmodSync(path, 0o644);
  await assert.rejects(auth.accessToken(), /must not be readable by group or others/);
  writeFileSync(path, JSON.stringify(authJson("acct", 1_000_000_000)));
  chmodSync(path, 0o600);
  await assert.rejects(auth.accessToken(), /has expired; run the Codex CLI to refresh it/);
});
