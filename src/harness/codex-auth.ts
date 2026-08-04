export function parseCodexAuthJson(value: string): Record<string, unknown> {
  let auth: unknown;
  try {
    auth = JSON.parse(value);
  } catch {
    throw new Error("Codex auth must contain valid JSON");
  }
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error("Codex auth must contain a JSON object");
  }
  const record = auth as Record<string, unknown>;
  const tokens = record.tokens;
  const tokenRecord =
    tokens && typeof tokens === "object" && !Array.isArray(tokens) ? (tokens as Record<string, unknown>) : {};
  const credentials = [record.OPENAI_API_KEY, tokenRecord.access_token, tokenRecord.refresh_token];
  if (!credentials.some((credential) => usableCredential(credential))) {
    throw new Error("Codex auth JSON must contain a usable access or refresh credential");
  }
  return record;
}

export function codexAuthJson(source: NodeJS.ProcessEnv): string | undefined {
  const explicit = source.CODEX_AUTH_JSON?.trim();
  if (explicit) return explicit;
  const accessToken = source.CODEX_ACCESS_TOKEN?.trim();
  return accessToken?.startsWith("{") ? accessToken : undefined;
}

export function codexNativeAuthPresent(source: NodeJS.ProcessEnv): boolean {
  const authJson = codexAuthJson(source);
  if (authJson) {
    try {
      parseCodexAuthJson(authJson);
      return true;
    } catch {
      return false;
    }
  }
  return usableCredential(source.CODEX_ACCESS_TOKEN);
}

function usableCredential(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    !/^(replace-me|placeholder|changeme|todo)$/i.test(value.trim())
  );
}
