import type { ModelProvider } from "../../model/pi-models.ts";
import { completeClaudeLogin, startClaudeLogin } from "../../model/subscription-oauth.ts";
import { createCodexDeviceLogin } from "../../model/codex-device-login.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { validateProviderApiKey } from "./admin/model-providers.ts";
import type { ApiCtx, Route } from "./route.ts";
import { audit, authorizeAdmin, orgScope } from "./shared.ts";

interface Account {
  owner: string;
  actor: string;
}

type AccountOf = (ctx: ApiCtx) => Promise<Account | null>;

function caller(ctx: ApiCtx): string | null {
  return ctx.actor?.p ?? null;
}

const personal: AccountOf = async (ctx) => {
  const principal = caller(ctx);
  if (principal) return { owner: principal, actor: principal };
  sendJson(ctx.res, 401, { error: "unauthorized" });
  return null;
};

const organization: AccountOf = async (ctx) => {
  const admin = await authorizeAdmin(ctx, orgScope());
  return admin ? { owner: orgScope(), actor: admin.id } : null;
};

function bodyObj(ctx: ApiCtx): Record<string, unknown> {
  return typeof ctx.body === "object" && ctx.body !== null ? (ctx.body as Record<string, unknown>) : {};
}

function connectProvider(raw: unknown): ModelProvider | null {
  if (raw === "anthropic" || raw === "claude") return "anthropic";
  if (raw === "openai" || raw === "chatgpt" || raw === "codex") return "openai";
  return null;
}

async function getStatus(ctx: ApiCtx): Promise<void> {
  const principal = caller(ctx);
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const mode = (await ctx.deps.config?.getIndividualModelAuthModeDurable()) ?? "optional";
  const connections = (await ctx.deps.userModelCredentials?.connections(principal)) ?? [];
  const individualModelAuth = (await ctx.deps.config?.getIndividualModelAuthDurable(principal)) ?? false;
  const account = (await ctx.deps.config?.getModelAccountDurable(principal)) ?? "company";
  return sendJson(ctx.res, 200, { mode, individualModelAuth, account, connections });
}

async function setAccount(ctx: ApiCtx): Promise<void> {
  const principal = caller(ctx);
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (!ctx.deps.config || !ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const account = bodyObj(ctx).account;
  if (account !== "personal" && account !== "company") return sendJson(ctx.res, 400, { error: "bad_request" });
  if (account === "company" && (await ctx.deps.config.getIndividualModelAuthModeDurable()) === "required") {
    return sendJson(ctx.res, 403, { error: "Your organization requires a personal AI account." });
  }
  if (account === "personal" && !(await ctx.deps.userModelCredentials.connections(principal)).length) {
    return sendJson(ctx.res, 409, { error: "Connect an AI account first." });
  }
  const provider = bodyObj(ctx).provider;
  if (provider !== undefined && provider !== "anthropic" && provider !== "openai")
    return sendJson(ctx.res, 400, { error: "bad_request" });
  if (
    account === "personal" &&
    provider &&
    !(await ctx.deps.userModelCredentials.connections(principal)).some((c) => c.provider === provider)
  ) {
    return sendJson(ctx.res, 409, { error: "Connect this AI account first." });
  }
  await ctx.deps.config.setPersonalModelAuth(principal, account === "personal");
  audit(ctx.deps, {
    principalId: principal,
    action: "user-model-auth.account",
    resource: account,
    scopeLabel: principal,
  });
  return getStatus(ctx);
}

function disconnect(accountOf: AccountOf) {
  return async (ctx: ApiCtx): Promise<void> => {
    const account = await accountOf(ctx);
    if (!account) return;
    if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
    const provider = connectProvider(bodyObj(ctx).provider);
    if (!provider)
      return sendJson(ctx.res, 400, { error: "bad_request", message: "provider must be claude or chatgpt" });
    await ctx.deps.userModelCredentials.delete(account.owner, provider);
    audit(ctx.deps, {
      principalId: account.actor,
      action: "user-model-auth.disconnect",
      resource: provider,
      scopeLabel: account.owner,
    });
    return sendJson(ctx.res, 200, { ok: true });
  };
}

async function putApiKey(ctx: ApiCtx): Promise<void> {
  const principal = caller(ctx);
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const body = bodyObj(ctx);
  const provider = connectProvider(body.provider);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!provider) return sendJson(ctx.res, 400, { error: "bad_request", message: "provider must be claude or chatgpt" });
  if (!apiKey) return sendJson(ctx.res, 400, { error: "bad_request", message: "API key is required" });
  if (!(await validateProviderApiKey(ctx, provider, apiKey))) {
    return sendJson(ctx.res, 400, { error: "invalid_api_key", message: `${provider} rejected this API key` });
  }
  await ctx.deps.userModelCredentials.setApiKey(principal, provider, apiKey);
  audit(ctx.deps, {
    principalId: principal,
    action: "user-model-auth.api-key",
    resource: provider,
    scopeLabel: principal,
  });
  return sendJson(ctx.res, 200, { ok: true });
}

const codexDeviceLogin = createCodexDeviceLogin();

function chatgptStart(accountOf: AccountOf) {
  return async (ctx: ApiCtx): Promise<void> => {
    if (!(await accountOf(ctx))) return;
    try {
      return sendJson(ctx.res, 200, await codexDeviceLogin.start());
    } catch (e) {
      return sendJson(ctx.res, 502, { error: "oauth_start_failed", message: errMessage(e) });
    }
  };
}

function chatgptPoll(accountOf: AccountOf) {
  return async (ctx: ApiCtx): Promise<void> => {
    const account = await accountOf(ctx);
    if (!account) return;
    if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
    const deviceAuthId = bodyObj(ctx).deviceAuthId;
    if (typeof deviceAuthId !== "string" || !deviceAuthId) return sendJson(ctx.res, 400, { error: "bad_request" });
    try {
      const result = await codexDeviceLogin.poll(deviceAuthId);
      if (result === "pending") return sendJson(ctx.res, 200, { status: "pending" });
      await ctx.deps.userModelCredentials.setOAuth(account.owner, "openai", result);
      audit(ctx.deps, {
        principalId: account.actor,
        action: "user-model-auth.oauth",
        resource: "openai",
        scopeLabel: account.owner,
      });
      return sendJson(ctx.res, 200, { status: "connected" });
    } catch (e) {
      return sendJson(ctx.res, 502, { error: "oauth_poll_failed", message: errMessage(e) });
    }
  };
}

function claudeStart(accountOf: AccountOf) {
  return async (ctx: ApiCtx): Promise<void> => {
    if (!(await accountOf(ctx))) return;
    return sendJson(ctx.res, 200, startClaudeLogin());
  };
}

function claudeComplete(accountOf: AccountOf) {
  return async (ctx: ApiCtx): Promise<void> => {
    const account = await accountOf(ctx);
    if (!account) return;
    if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
    const body = bodyObj(ctx);
    const code = typeof body.code === "string" ? body.code : "";
    const verifier = typeof body.verifier === "string" ? body.verifier : "";
    if (!code || !verifier) return sendJson(ctx.res, 400, { error: "bad_request" });
    try {
      const tokens = await completeClaudeLogin(code, verifier);
      await ctx.deps.userModelCredentials.setOAuth(account.owner, "anthropic", tokens);
      audit(ctx.deps, {
        principalId: account.actor,
        action: "user-model-auth.oauth",
        resource: "anthropic",
        scopeLabel: account.owner,
      });
      return sendJson(ctx.res, 200, { ok: true });
    } catch (e) {
      return sendJson(ctx.res, 502, { error: "oauth_complete_failed", message: errMessage(e) });
    }
  };
}

async function getOrgStatus(ctx: ApiCtx): Promise<void> {
  const account = await organization(ctx);
  if (!account) return;
  const connections = (await ctx.deps.userModelCredentials?.connections(account.owner)) ?? [];
  return sendJson(ctx.res, 200, { connections });
}

function personalAccountsAllowed(handle: (ctx: ApiCtx) => Promise<void>): (ctx: ApiCtx) => Promise<void> {
  return async (ctx) => {
    if ((await ctx.deps.config?.getIndividualModelAuthModeDurable()) === "org-only")
      return sendJson(ctx.res, 403, {
        error: "personal_accounts_disabled",
        message: "Your organization runs QM on its own AI accounts.",
      });
    return handle(ctx);
  };
}

export const userModelAuthRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/user-model-auth/account", auth: "source", handle: personalAccountsAllowed(setAccount) },
  { method: "GET", path: "/v1/user-model-auth/status", auth: "source", handle: getStatus },
  { method: "POST", path: "/v1/user-model-auth/api-key", auth: "source", handle: personalAccountsAllowed(putApiKey) },
  { method: "POST", path: "/v1/user-model-auth/disconnect", auth: "source", handle: disconnect(personal) },
  {
    method: "POST",
    path: "/v1/user-model-auth/chatgpt/start",
    auth: "source",
    handle: personalAccountsAllowed(chatgptStart(personal)),
  },
  {
    method: "POST",
    path: "/v1/user-model-auth/chatgpt/poll",
    auth: "source",
    handle: personalAccountsAllowed(chatgptPoll(personal)),
  },
  {
    method: "POST",
    path: "/v1/user-model-auth/claude/start",
    auth: "source",
    handle: personalAccountsAllowed(claudeStart(personal)),
  },
  {
    method: "POST",
    path: "/v1/user-model-auth/claude/complete",
    auth: "source",
    handle: personalAccountsAllowed(claudeComplete(personal)),
  },
  { method: "GET", path: "/v1/admin/model-accounts", auth: "either", handle: getOrgStatus },
  { method: "POST", path: "/v1/admin/model-accounts/disconnect", auth: "either", handle: disconnect(organization) },
  {
    method: "POST",
    path: "/v1/admin/model-accounts/chatgpt/start",
    auth: "either",
    handle: chatgptStart(organization),
  },
  { method: "POST", path: "/v1/admin/model-accounts/chatgpt/poll", auth: "either", handle: chatgptPoll(organization) },
  { method: "POST", path: "/v1/admin/model-accounts/claude/start", auth: "either", handle: claudeStart(organization) },
  {
    method: "POST",
    path: "/v1/admin/model-accounts/claude/complete",
    auth: "either",
    handle: claudeComplete(organization),
  },
];
