import { createServer, type Server, type Socket } from "node:net";

interface FakeSmtp {
  port: number;
  transcript: string[];
  messages: string[];
  close(): Promise<void>;
}

export async function fakeSmtp(
  options: { offerStartTls?: boolean; rejectAuth?: boolean; rejectRecipient?: boolean } = {},
): Promise<FakeSmtp> {
  const transcript: string[] = [];
  const messages: string[] = [];
  const handle = (socket: Socket): void => {
    let buffer = "";
    let inData = false;
    let message = "";
    socket.setEncoding("utf8");
    socket.write("220 fake.smtp.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end === -1) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(message);
            message = "";
            socket.write("250 2.0.0 Ok: queued as FAKE1\r\n");
          } else message += `${line.startsWith(".") ? line.slice(1) : line}\n`;
          continue;
        }
        transcript.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO")
          socket.write(
            `250-fake.smtp.test\r\n${options.offerStartTls ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN LOGIN\r\n`,
          );
        else if (verb === "AUTH")
          socket.write(options.rejectAuth ? "535 5.7.8 bad credentials\r\n" : "235 2.7.0 Accepted\r\n");
        else if (verb === "MAIL") socket.write("250 2.1.0 Ok\r\n");
        else if (verb === "RCPT")
          socket.write(options.rejectRecipient ? "550 5.1.1 no such user\r\n" : "250 2.1.5 Ok\r\n");
        else if (verb === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else socket.write("502 5.5.2 not implemented\r\n");
      }
    });
    socket.on("error", () => undefined);
  };
  const server: Server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    transcript,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
