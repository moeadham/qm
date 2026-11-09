import { buildContextWindow, type RecentMessage } from "../surfaces/conversation.ts";
import type { SurfaceContextRequest } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { discordDisplayName, messageAttachments, messageText, type DiscordApi, type DiscordMessage } from "./api.ts";
import type { DiscordCoreClient } from "./core.ts";
import { receiveDiscordFiles } from "./files.ts";

const PAGE = 100;
const SCAN_PAGES_FOR_MATCH = 3;
const DEFAULT_COUNT = 50;

export function createDiscordContextFulfiller(deps: {
  api: Pick<DiscordApi, "recentMessages" | "message">;
  core: Pick<DiscordCoreClient, "fulfillContextRequest" | "stageBlob">;
  selfId: string;
  fetchImpl?: typeof fetch;
}): (request: SurfaceContextRequest) => Promise<void> {
  const { api, core } = deps;

  async function readHistory(channelId: string, before: string | undefined, pages: number) {
    const raw: DiscordMessage[] = [];
    let cursor = before;
    let hasMore = false;
    for (let page = 0; page < pages; page++) {
      const batch = await api.recentMessages(channelId, PAGE, cursor);
      raw.push(...batch);
      hasMore = batch.length === PAGE;
      if (!hasMore) break;
      cursor = batch.at(-1)!.id;
    }
    return { raw, hasMore };
  }

  async function fetchFile(channelId: string, file: { ts: string; name?: string }) {
    const message = await api.message(channelId, file.ts);
    const candidates = messageAttachments(message).filter((a) => !file.name || a.filename === file.name);
    if (!candidates.length)
      return { error: file.name ? `no file named "${file.name}" on that message` : "that message has no files" };
    const { attachments, issues } = await receiveDiscordFiles(
      candidates.slice(0, 1),
      (bytes) => core.stageBlob(bytes),
      discordDisplayName(message.author),
      deps.fetchImpl,
    );
    const got = attachments[0];
    if (!got) return { error: issues[0] ?? "I couldn't read that file" };
    return {
      messages: [],
      file: {
        blobId: got.blobId,
        name: got.name,
        mimetype: got.mimetype,
        sizeBytes: got.sizeBytes,
        ...(got.author ? { author: got.author } : {}),
      },
    };
  }

  return async (request) => {
    const q = request.query ?? {};
    const post = (body: { error?: string } & Record<string, unknown>) =>
      core.fulfillContextRequest(
        request.id,
        typeof body.error === "string"
          ? { error: body.error }
          : { result: { ...body, messages: (body.messages as unknown[] | undefined) ?? [] } },
      );
    try {
      if (!q.conversationTarget) {
        return await post({
          error:
            q.channelId || q.channelName
              ? "reading other channels isn't supported on Discord yet"
              : "malformed context request",
        });
      }
      if (q.searchAll || q.openGroup || q.syncDirectory) {
        return await post({ error: "that isn't supported on Discord" });
      }
      const channelId = q.conversationTarget.split(":")[0]!;
      if (q.file?.ts) return await post(await fetchFile(channelId, q.file));
      const count = Math.max(1, Math.min(PAGE * SCAN_PAGES_FOR_MATCH, Number(q.count) || DEFAULT_COUNT));
      const match = typeof q.match === "string" && q.match.trim() ? q.match.trim() : undefined;
      const before = typeof q.before === "string" && q.before ? q.before : undefined;
      const { raw, hasMore } = await readHistory(channelId, before, match || count > PAGE ? SCAN_PAGES_FOR_MATCH : 1);
      const nameById = new Map<string, string>();
      const shaped: RecentMessage[] = raw
        .filter((m) => messageText(m).trim() || messageAttachments(m).length)
        .map((m) => {
          nameById.set(m.author.id, discordDisplayName(m.author));
          return {
            ts: m.id,
            name: discordDisplayName(m.author),
            authorId: m.author.id,
            text: messageText(m),
            parentTs: channelId,
            ...(messageAttachments(m).length ? { files: messageAttachments(m).map((a) => a.filename) } : {}),
            ...(m.author.bot ? { isBot: true } : {}),
            ...(m.author.id === deps.selfId ? { isSelf: true } : {}),
          };
        });
      return await post(
        buildContextWindow(shaped, { count, ...(match ? { match } : {}), scanHasMore: hasMore, nameById }),
      );
    } catch (error) {
      return await post({ error: `Discord read failed: ${errMessage(error)}` });
    }
  };
}
