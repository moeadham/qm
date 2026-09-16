import { randomBytes } from "node:crypto";
import { emailConfigured, senderAddress, type EmailConfig } from "./email-config.ts";
import { smtpDeliver } from "./smtp.ts";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: OutgoingEmail): Promise<string>;
  verify(): Promise<string>;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_VERIFY_ENDPOINT = "https://api.resend.com/domains";
const RESEND_TIMEOUT_MS = 15_000;

export function resendMailer(cfg: EmailConfig, fetchImpl: typeof fetch = fetch): Mailer {
  const authorization = `Bearer ${cfg.resendApiKey}`;
  return {
    async send(message) {
      const r = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          from: cfg.emailFrom,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      const body = (await r.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (!r.ok)
        throw new Error(`Resend rejected the message: HTTP ${r.status} ${body.message ?? body.name ?? ""}`.trim());
      return body.id ?? "accepted";
    },
    async verify() {
      const r = await fetchImpl(RESEND_VERIFY_ENDPOINT, {
        headers: { authorization },
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      if (r.status === 401 || r.status === 403) throw new Error("Resend rejected RESEND_API_KEY");
      if (!r.ok) throw new Error(`Resend API returned HTTP ${r.status}`);
      return "Resend API key accepted";
    },
  };
}

function smtpMailer(cfg: EmailConfig): Mailer {
  const options = { ...cfg.smtp };
  const from = senderAddress(cfg.emailFrom);
  return {
    async send(message) {
      return smtpDeliver(options, { from, to: message.to, data: renderMessage(cfg, message) });
    },
    async verify() {
      return `SMTP ${cfg.smtp.host}:${cfg.smtp.port} ${await smtpDeliver(options, null)}`;
    },
  };
}

export function mailerFor(cfg: EmailConfig): Mailer | null {
  if (!emailConfigured(cfg)) return null;
  return cfg.transport === "smtp" ? smtpMailer(cfg) : resendMailer(cfg);
}

function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function base64Body(value: string): string {
  return (
    Buffer.from(value.replace(/\r?\n/g, "\r\n"), "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
}

export function renderMessage(cfg: EmailConfig, message: OutgoingEmail, nowMs = Date.now()): string {
  const boundary = `qm-${randomBytes(12).toString("hex")}`;
  const domain = senderAddress(cfg.emailFrom).split("@")[1] ?? "localhost";
  const headers = [
    `From: ${encodeHeader(cfg.emailFrom)}`,
    `To: ${encodeHeader(message.to)}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date(nowMs).toUTCString()}`,
    `Message-ID: <${randomBytes(16).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  return [
    headers.join("\r\n"),
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(message.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(message.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
