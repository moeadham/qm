import {
  MAX_ATTACHMENT_BYTES,
  processInboundFiles,
  readOutgoingAttachment,
  type BlobSource,
  type OutgoingAttachment,
  type ProcessedInbound,
  type SlackFile,
} from "../slack/attachments.ts";
import { messageNonce, type DiscordApi, type DiscordAttachment } from "./api.ts";

const DISCORD_FILE_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
export const DISCORD_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
const FILES_PER_MESSAGE = 10;

export function isDiscordFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && DISCORD_FILE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export async function downloadDiscordFile(file: SlackFile, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const url = file.url_private;
  if (!url || !isDiscordFileUrl(url)) throw new Error("file is not hosted by Discord; refusing to fetch");
  const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? "0") > MAX_ATTACHMENT_BYTES) throw new Error("file too large");
  return new Uint8Array(await res.arrayBuffer());
}

export function receiveDiscordFiles(
  attachments: readonly DiscordAttachment[],
  stage: (bytes: Uint8Array) => Promise<{ blobId: string }>,
  author: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProcessedInbound> {
  const files: SlackFile[] = attachments.map((a) => ({
    id: a.id,
    name: a.filename,
    size: a.size,
    url_private: a.url,
    ...(a.content_type ? { mimetype: a.content_type } : {}),
  }));
  return processInboundFiles(
    files,
    (f) => downloadDiscordFile(f, fetchImpl),
    stage,
    () => author,
    "",
  );
}

export async function sendDiscordFiles(
  api: Pick<DiscordApi, "sendFiles">,
  blobs: BlobSource,
  channelId: string,
  attachments: readonly OutgoingAttachment[],
  opts: { key: string; replyTo?: string },
): Promise<string[]> {
  const ready: Array<{ name: string; data: Buffer }> = [];
  const problems: string[] = [];
  for (const a of attachments) {
    if (a.sizeBytes > DISCORD_UPLOAD_LIMIT_BYTES) {
      problems.push(`"${a.name}" is too large for Discord (10 MB limit)`);
      continue;
    }
    const data = await readOutgoingAttachment(a, blobs);
    if (data.length > DISCORD_UPLOAD_LIMIT_BYTES) problems.push(`"${a.name}" is too large for Discord (10 MB limit)`);
    else if (data.length > 0) ready.push({ name: a.name, data });
  }
  const batches: Array<Array<{ name: string; data: Buffer }>> = [];
  let bytes = 0;
  for (const file of ready) {
    const current = batches.at(-1);
    if (!current || current.length >= FILES_PER_MESSAGE || bytes + file.data.length > DISCORD_UPLOAD_LIMIT_BYTES) {
      batches.push([file]);
      bytes = file.data.length;
    } else {
      current.push(file);
      bytes += file.data.length;
    }
  }
  for (const [i, batch] of batches.entries())
    await api.sendFiles(channelId, batch, {
      nonce: messageNonce(`${opts.key}:files`, i),
      ...(i === 0 && opts.replyTo ? { replyTo: opts.replyTo } : {}),
    });
  return problems;
}
