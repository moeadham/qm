import { escapeHtml } from "../api/http.ts";
import { mailerFor, type Mailer } from "../../plugins/chassis/src/email.ts";
import type { EmailConfig } from "../../plugins/chassis/src/email-config.ts";

export type InviteMailer = Pick<Mailer, "send">;

export const INVITE_EMAIL_NOT_CONFIGURED =
  "invitation emails are not configured — configure AUTH_EMAIL_TRANSPORT and AUTH_EMAIL_FROM on core, with SMTP_HOST/SMTP_USERNAME/SMTP_PASSWORD for SMTP or RESEND_API_KEY for Resend";

export function createInviteMailer(config?: EmailConfig, production = false): InviteMailer | null {
  const mailer = config ? mailerFor(config) : null;
  if (mailer && config?.transport === "smtp") {
    if (!Number.isInteger(config.smtp.port) || config.smtp.port < 1 || config.smtp.port > 65535)
      throw new Error("SMTP_PORT must be a TCP port number");
    if (production && config.smtp.tls === "none") throw new Error("SMTP_TLS=none may not be used in production");
  }
  return mailer;
}

export function renderInviteEmail(a: {
  to: string;
  brandName: string;
  invitedBy: string;
  signInUrl: string;
  expiresAt: number;
}): { subject: string; text: string; html: string } {
  const ends = new Date(a.expiresAt).toUTCString();
  const subject = `You've been invited to ${a.brandName}`;
  const text = [
    subject,
    "",
    `${a.invitedBy} invited you to ${a.brandName}.`,
    "",
    `Sign in at ${a.signInUrl} using this email address (${a.to}) — a one-time link is emailed to you at sign-in.`,
    "",
    `Your access ends on ${ends}.`,
  ].join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f5f5f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e5e5e5;border-radius:16px;padding:32px;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0a0a">
<tr><td>
<h1 style="margin:0 0 10px;font-size:20px;font-weight:600">${escapeHtml(subject)}</h1>
<p style="margin:0 0 24px;color:#525252">${escapeHtml(a.invitedBy)} invited you to ${escapeHtml(a.brandName)}. Sign in using this email address (${escapeHtml(a.to)}) — a one-time link is emailed to you at sign-in.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(a.signInUrl)}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;font-weight:600;padding:13px 22px;border-radius:10px">Sign in</a></p>
<p style="margin:0 0 8px;color:#737373;font-size:13px">Or paste this address into your browser:</p>
<p style="margin:0 0 24px;word-break:break-all;font-size:12px;color:#525252">${escapeHtml(a.signInUrl)}</p>
<p style="margin:0;color:#737373;font-size:13px">Your access ends on ${escapeHtml(ends)}.</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}
