import { randomBytes } from "node:crypto";
import * as tls from "node:tls";

/**
 * A minimal raw IRC client used only to run ChanServ admin commands as a
 * temporary operator — connect, register, /OPER, send a handful of
 * PRIVMSGs to ChanServ, read its NOTICE replies, disconnect. Not a general
 * IRC library; just enough of the protocol for this one job.
 */

const CONNECT_TIMEOUT_MS = 5000;
const REGISTER_TIMEOUT_MS = 5000;
const OPER_TIMEOUT_MS = 5000;
const CHANSERV_REPLY_TIMEOUT_MS = 4000;
/** How long to keep collecting ChanServ NOTICE lines after the last one arrives. */
const CHANSERV_QUIET_PERIOD_MS = 400;

export interface IrcLine {
  raw: string;
  prefix: string | null;
  command: string;
  params: string[];
}

/** Parses one raw IRC protocol line (without the trailing CRLF). */
export function parseIrcLine(raw: string): IrcLine {
  let rest = raw;
  let prefix: string | null = null;

  if (rest.startsWith(":")) {
    const spaceIndex = rest.indexOf(" ");
    prefix = rest.slice(1, spaceIndex === -1 ? undefined : spaceIndex);
    rest = spaceIndex === -1 ? "" : rest.slice(spaceIndex + 1);
  }

  const trailingIndex = rest.indexOf(" :");
  let paramsPart: string;
  let trailing: string | null = null;

  if (trailingIndex >= 0) {
    paramsPart = rest.slice(0, trailingIndex);
    trailing = rest.slice(trailingIndex + 2);
  } else if (rest.startsWith(":")) {
    paramsPart = "";
    trailing = rest.slice(1);
  } else {
    paramsPart = rest;
  }

  const params = paramsPart.split(" ").filter((p) => p.length > 0);
  if (trailing !== null) {
    params.push(trailing);
  }

  const command = params.shift() ?? "";

  return { raw, prefix, command, params };
}

/** The nick portion of a prefix like "ChanServ!ChanServ@localhost". */
function prefixNick(prefix: string | null): string | null {
  if (!prefix) {
    return null;
  }
  const bang = prefix.indexOf("!");
  return bang >= 0 ? prefix.slice(0, bang) : prefix;
}

export class IrcOperAuthError extends Error {}
export class IrcRegistrationError extends Error {}

export class IrcServiceSession {
  private socket: tls.TLSSocket;
  private buffer = "";
  private lineHandlers: Array<(line: IrcLine) => void> = [];

  private constructor(socket: tls.TLSSocket) {
    this.socket = socket;
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\r\n");
    this.buffer = lines.pop() ?? "";

    for (const raw of lines) {
      if (!raw) {
        continue;
      }
      const line = parseIrcLine(raw);
      for (const handler of this.lineHandlers) {
        handler(line);
      }
    }
  }

  private send(command: string): void {
    this.socket.write(`${command}\r\n`);
  }

  private waitFor(predicate: (line: IrcLine) => boolean, timeoutMs: number): Promise<IrcLine> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for a response from the IRC server"));
      }, timeoutMs);

      const handler = (line: IrcLine) => {
        if (predicate(line)) {
          cleanup();
          resolve(line);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.lineHandlers = this.lineHandlers.filter((h) => h !== handler);
      };

      this.lineHandlers.push(handler);
    });
  }

  /** Opens a TLS connection. Certificate is expected to be self-signed (an internal, platform-managed connection). */
  static connect(host: string, port: number): Promise<IrcServiceSession> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(
        { host, port, rejectUnauthorized: false, timeout: CONNECT_TIMEOUT_MS },
        () => {
          socket.removeListener("error", onError);
          resolve(new IrcServiceSession(socket));
        }
      );

      const onError = (error: Error) => reject(error);
      socket.once("error", onError);
      socket.once("timeout", () => {
        socket.destroy();
        reject(new Error("Timed out connecting to the IRC server"));
      });
    });
  }

  /** NICK/USER registration under a randomized service nick, then waits for RPL_WELCOME (001). */
  async register(): Promise<string> {
    const nick = `svc-${randomBytes(4).toString("hex")}`;
    this.send(`NICK ${nick}`);
    this.send(`USER ${nick} 0 * :Deployment Platform`);

    const result = await Promise.race([
      this.waitFor((line) => line.command === "001", REGISTER_TIMEOUT_MS),
      this.waitFor(
        (line) => line.command === "433" || line.command === "437" || line.command === "FAIL",
        REGISTER_TIMEOUT_MS
      )
    ]);

    if (result.command !== "001") {
      throw new IrcRegistrationError(
        `Unable to register a connection with the IRC server: ${result.params.at(-1) ?? result.raw}`
      );
    }

    return nick;
  }

  /** Sends /OPER and waits for RPL_YOUREOPER (381) or a rejection. */
  async oper(username: string, password: string): Promise<void> {
    this.send(`OPER ${username} ${password}`);

    const result = await Promise.race([
      this.waitFor((line) => line.command === "381", OPER_TIMEOUT_MS),
      this.waitFor(
        (line) => line.command === "464" || line.command === "491",
        OPER_TIMEOUT_MS
      )
    ]);

    if (result.command !== "381") {
      throw new IrcOperAuthError(`Unable to gain operator privileges: ${result.params.at(-1) ?? result.raw}`);
    }
  }

  /**
   * Sends a PRIVMSG to ChanServ and collects its NOTICE reply lines until a
   * short quiet period passes with no new lines — ChanServ's replies are
   * always a burst of NOTICEs with no explicit terminator token in the
   * protocol itself (only conventional "*** End of ... ***" text).
   */
  chanServCommand(command: string): Promise<string[]> {
    return new Promise((resolve) => {
      const collected: string[] = [];
      let quietTimer: NodeJS.Timeout | null = null;

      const finish = () => {
        clearTimeout(overallTimer);
        if (quietTimer) {
          clearTimeout(quietTimer);
        }
        this.lineHandlers = this.lineHandlers.filter((h) => h !== handler);
        resolve(collected);
      };

      const overallTimer = setTimeout(finish, CHANSERV_REPLY_TIMEOUT_MS);

      const handler = (line: IrcLine) => {
        if (line.command !== "NOTICE" || prefixNick(line.prefix) !== "ChanServ") {
          return;
        }
        collected.push(line.params.at(-1) ?? "");
        if (quietTimer) {
          clearTimeout(quietTimer);
        }
        quietTimer = setTimeout(finish, CHANSERV_QUIET_PERIOD_MS);
      };

      this.lineHandlers.push(handler);
      this.send(`PRIVMSG ChanServ :${command}`);
    });
  }

  close(): void {
    try {
      this.send("QUIT");
    } catch {
      // socket may already be closing
    }
    this.socket.destroy();
  }
}

/**
 * Connects, registers, opers up, runs `fn`, and always disconnects
 * afterward — the shared shape every ChanServ-driven admin action needs.
 */
export async function withIrcServiceSession<T>(
  host: string,
  port: number,
  operatorUsername: string,
  operatorPassword: string,
  fn: (session: IrcServiceSession) => Promise<T>
): Promise<T> {
  const session = await IrcServiceSession.connect(host, port);

  try {
    await session.register();
    await session.oper(operatorUsername, operatorPassword);
    return await fn(session);
  } finally {
    session.close();
  }
}
