import { accessExpiresAt, authTokens, loadCodexAuthFile } from "./chatgpt-auth-file.ts";

export interface CompanyChatGPTAuth {
  readonly description: string;
  accessToken(): Promise<string | undefined>;
}

export function fileCompanyChatGPTAuth(path: string): CompanyChatGPTAuth {
  return {
    description: `auth file ${path}`,
    async accessToken() {
      const auth = loadCodexAuthFile(path);
      const expiresAt = accessExpiresAt(auth);
      if (expiresAt !== undefined && expiresAt <= Date.now())
        throw new Error(`the ChatGPT login in ${path} has expired; run the Codex CLI to refresh it`);
      return authTokens(auth)?.access;
    },
  };
}
