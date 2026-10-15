import assert from "node:assert/strict";
import test from "node:test";
import { createInviteMailer, renderInviteEmail } from "../src/admin/invite-email.ts";
import { loadConfig } from "../src/config.ts";
import { readEmailConfig } from "../plugins/chassis/src/email-config.ts";
import { fakeSmtp } from "../plugins/chassis/test/smtp-fixture.ts";

const invite = {
  to: "guest@example.test",
  ...renderInviteEmail({
    to: "guest@example.test",
    brandName: "Example",
    invitedBy: "owner@example.test",
    signInUrl: "https://example.test/auth/login",
    expiresAt: Date.UTC(2027, 0, 1),
  }),
};

test("core invitation mail uses the configured SMTP transport without a Resend key", async () => {
  const server = await fakeSmtp();
  try {
    const config = loadConfig({
      AUTH_EMAIL_TRANSPORT: "smtp",
      AUTH_EMAIL_FROM: "Example <no-reply@example.test>",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(server.port),
      SMTP_TLS: "none",
      SMTP_USERNAME: "user",
      SMTP_PASSWORD: "password",
    });
    const mailer = createInviteMailer(config.email);
    assert.ok(mailer);
    assert.match(await mailer.send(invite), /FAKE1/);
    assert.ok(server.transcript.includes("MAIL FROM:<no-reply@example.test>"));
    assert.ok(server.transcript.includes("RCPT TO:<guest@example.test>"));
    assert.equal(server.messages.length, 1);
    assert.ok(
      server.messages[0]!.includes(Buffer.from(invite.text.replace(/\n/g, "\r\n")).toString("base64").slice(0, 60)),
    );
    assert.match(server.messages[0]!, /multipart\/alternative/);
  } finally {
    await server.close();
  }
});

test("SMTP invitation failures propagate without falling back to Resend", async () => {
  const server = await fakeSmtp({ rejectRecipient: true });
  try {
    const mailer = createInviteMailer(
      readEmailConfig({
        AUTH_EMAIL_TRANSPORT: "smtp",
        AUTH_EMAIL_FROM: "sender@example.test",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(server.port),
        SMTP_TLS: "none",
        SMTP_USERNAME: "u",
        SMTP_PASSWORD: "p",
        RESEND_API_KEY: "unused",
      }),
    );
    await assert.rejects(mailer!.send(invite), /550/);
    assert.equal(server.messages.length, 0);
  } finally {
    await server.close();
  }
});

test("missing SMTP credentials do not select an otherwise configured Resend transport", () => {
  assert.equal(
    createInviteMailer(
      readEmailConfig({
        AUTH_EMAIL_TRANSPORT: "smtp",
        AUTH_EMAIL_FROM: "sender@example.test",
        RESEND_API_KEY: "unused",
      }),
    ),
    null,
  );
  assert.equal(createInviteMailer(), null);
  assert.ok(createInviteMailer(readEmailConfig({ AUTH_EMAIL_FROM: "sender@example.test", RESEND_API_KEY: "resend" })));
});

test("invitation SMTP refuses cleartext production authentication and invalid ports", () => {
  const cfg = readEmailConfig({
    AUTH_EMAIL_TRANSPORT: "smtp",
    AUTH_EMAIL_FROM: "sender@example.test",
    SMTP_HOST: "mail.example.test",
    SMTP_USERNAME: "u",
    SMTP_PASSWORD: "p",
    SMTP_TLS: "none",
  });
  assert.throws(() => createInviteMailer(cfg, true), /may not be used in production/);
  assert.throws(() => createInviteMailer({ ...cfg, smtp: { ...cfg.smtp, port: 65536 } }), /TCP port/);
  assert.equal(readEmailConfig({ SMTP_PORT: "465" }).smtp.tls, "implicit");
  assert.equal(readEmailConfig({}).smtp.tls, "starttls");
});
