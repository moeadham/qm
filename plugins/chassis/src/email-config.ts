import type { SmtpTlsMode } from "./smtp.ts";

type EmailTransportKind = "resend" | "smtp";

interface SmtpSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: SmtpTlsMode;
}

export interface EmailConfig {
  emailFrom: string;
  transport: EmailTransportKind;
  resendApiKey: string;
  smtp: SmtpSettings;
}
function numberFrom(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function smtpTlsFrom(mode: string | undefined, port: string | undefined): SmtpTlsMode {
  const declared = mode?.trim();
  if (declared === "implicit" || declared === "none" || declared === "starttls") return declared;
  return port?.trim() === "465" ? "implicit" : "starttls";
}

export function readEmailConfig(env: NodeJS.ProcessEnv): EmailConfig {
  return {
    emailFrom: env.AUTH_EMAIL_FROM?.trim() ?? "",
    transport: env.AUTH_EMAIL_TRANSPORT?.trim() === "smtp" ? "smtp" : "resend",
    resendApiKey: env.RESEND_API_KEY ?? "",
    smtp: {
      host: env.SMTP_HOST?.trim() ?? "",
      port: numberFrom(env.SMTP_PORT, 587),
      username: env.SMTP_USERNAME ?? "",
      password: env.SMTP_PASSWORD ?? "",
      tls: smtpTlsFrom(env.SMTP_TLS, env.SMTP_PORT),
    },
  };
}

export function emailConfigured(cfg: EmailConfig): boolean {
  const credentials =
    cfg.transport === "resend" ? [cfg.resendApiKey] : [cfg.smtp.host, cfg.smtp.username, cfg.smtp.password];
  return [cfg.emailFrom, ...credentials].every((value) => Boolean(value.trim()));
}

export function senderAddress(from: string): string {
  const angled = /<([^>]+)>\s*$/.exec(from.trim());
  return (angled?.[1] ?? from).trim();
}
