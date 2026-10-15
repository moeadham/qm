import test from "node:test";
import assert from "node:assert/strict";
import { fakeSmtp } from "../../chassis/test/smtp-fixture.ts";
import { dotStuff, smtpDeliver, takeReply } from "../src/smtp.ts";

const options = (port: number, over: Record<string, unknown> = {}) => ({
  host: "127.0.0.1",
  port,
  username: "apikey",
  password: "s3cret",
  tls: "none" as const,
  timeoutMs: 4000,
  ...over,
});

test("takeReply reassembles a multi-line reply and leaves the remainder", () => {
  const reply = takeReply("250-one\r\n250 two\r\n334 next\r\n");
  assert.deepEqual(reply, { code: 250, text: "one\ntwo", rest: "334 next\r\n" });
  assert.equal(takeReply("250-partial\r\n"), null);
  assert.equal(takeReply("garbage\r\n"), null);
});

test("dotStuff escapes a leading dot and normalises line endings", () => {
  assert.equal(dotStuff("a\n.b\nc"), "a\r\n..b\r\nc");
  assert.equal(dotStuff("a\r\n.\r\nb"), "a\r\n..\r\nb");
});

test("a message is delivered over the full SMTP conversation", async (t) => {
  const server = await fakeSmtp();
  t.after(() => server.close());
  const receipt = await smtpDeliver(options(server.port), {
    from: "no-reply@example.com",
    to: "admin@example.com",
    data: "Subject: hi\r\n\r\n.leading dot survives",
  });
  assert.match(receipt, /queued as FAKE1/);
  assert.deepEqual(
    server.transcript.map((line) => line.split(" ")[0]),
    ["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"],
  );
  assert.match(server.transcript[1]!, /^AUTH PLAIN /);
  assert.equal(
    Buffer.from(server.transcript[1]!.slice("AUTH PLAIN ".length), "base64").toString("utf8"),
    "\0apikey\0s3cret",
  );
  assert.match(server.messages[0]!, /^\.leading dot survives$/m);
});

test("a rejected recipient and rejected credentials both surface as errors", async (t) => {
  const rejecting = await fakeSmtp({ rejectRecipient: true });
  t.after(() => rejecting.close());
  await assert.rejects(
    () =>
      smtpDeliver(options(rejecting.port), {
        from: "no-reply@example.com",
        to: "nobody@example.com",
        data: "Subject: hi\r\n\r\nbody",
      }),
    /SMTP RCPT rejected: 550/,
  );

  const unauthorized = await fakeSmtp({ rejectAuth: true });
  t.after(() => unauthorized.close());
  await assert.rejects(() => smtpDeliver(options(unauthorized.port), null), /SMTP AUTH rejected: 535/);
});

test("verification authenticates without sending a message", async (t) => {
  const server = await fakeSmtp();
  t.after(() => server.close());
  assert.equal(await smtpDeliver(options(server.port), null), "authenticated");
  assert.deepEqual(
    server.transcript.map((line) => line.split(" ")[0]),
    ["EHLO", "AUTH", "QUIT"],
  );
  assert.equal(server.messages.length, 0);
});

test("STARTTLS mode refuses a server that does not advertise STARTTLS", async (t) => {
  const server = await fakeSmtp({ offerStartTls: false });
  t.after(() => server.close());
  await assert.rejects(() => smtpDeliver(options(server.port, { tls: "starttls" }), null), /does not offer STARTTLS/);
});

test("a connection refusal is reported rather than hanging", async () => {
  await assert.rejects(() => smtpDeliver(options(1, { timeoutMs: 2000 }), null));
});
