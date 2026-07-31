import * as tls from "node:tls";

/**
 * A minimal, persistent IRC client. Unlike the platform's own short-lived
 * irc-client-service.ts (which connects, runs one ChanServ command, and
 * disconnects), this stays connected indefinitely and lets callers register
 * standing line handlers via onLine().
 */

const CONNECT_TIMEOUT_MS = 5000;
const REGISTER_TIMEOUT_MS = 5000;
const OPER_TIMEOUT_MS = 5000;
const SERVICE_REPLY_TIMEOUT_MS = 4000;
/** How long to keep collecting a service's NOTICE lines after the last one arrives. */
const SERVICE_QUIET_PERIOD_MS = 400;

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

/** The nick portion of a prefix like "someone!user@host". */
export function prefixNick(prefix: string | null): string | null {
  if (!prefix) {
    return null;
  }
  const bang = prefix.indexOf("!");
  return bang >= 0 ? prefix.slice(0, bang) : prefix;
}

export class IrcRegistrationError extends Error {}
export class IrcOperAuthError extends Error {}

export class IrcConnection {
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

  send(command: string): void {
    this.socket.write(`${command}\r\n`);
  }

  /** Registers a standing handler for every parsed line. Returns an unsubscribe function. */
  onLine(handler: (line: IrcLine) => void): () => void {
    this.lineHandlers.push(handler);
    return () => {
      this.lineHandlers = this.lineHandlers.filter((h) => h !== handler);
    };
  }

  onClose(handler: () => void): void {
    this.socket.once("close", handler);
  }

  waitFor(predicate: (line: IrcLine) => boolean, timeoutMs: number): Promise<IrcLine> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out waiting for a response from the IRC server"));
      }, timeoutMs);

      const unsubscribe = this.onLine((line) => {
        if (predicate(line)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(line);
        }
      });
    });
  }

  /** Opens a TLS connection. Certificate is expected to be self-signed (an internal, platform-managed connection). */
  static connect(host: string, port: number): Promise<IrcConnection> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        socket.removeListener("error", onError);
        clearTimeout(connectTimer);
        // `tls.connect`'s own `timeout` option sets a persistent idle-socket
        // timeout, not a one-shot connect timeout — it would fire again after
        // every quiet period on the wire and silently kill live connections.
        // Use a manual timer for the connect phase only, and never arm the
        // socket-level timeout at all.
        resolve(new IrcConnection(socket));
      });

      const onError = (error: Error) => {
        clearTimeout(connectTimer);
        reject(error);
      };
      socket.once("error", onError);

      const connectTimer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Timed out connecting to the IRC server"));
      }, CONNECT_TIMEOUT_MS);
    });
  }

  async register(nick: string): Promise<void> {
    this.send(`NICK ${nick}`);
    this.send(`USER ${nick} 0 * :Quipora Bot`);

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
  }

  async oper(username: string, password: string): Promise<void> {
    this.send(`OPER ${username} ${password}`);

    const result = await Promise.race([
      this.waitFor((line) => line.command === "381", OPER_TIMEOUT_MS),
      this.waitFor((line) => line.command === "464" || line.command === "491", OPER_TIMEOUT_MS)
    ]);

    if (result.command !== "381") {
      throw new IrcOperAuthError(`Unable to gain operator privileges: ${result.params.at(-1) ?? result.raw}`);
    }
  }

  /**
   * Sends a PRIVMSG to an IRC service (NickServ, ChanServ, ...) and collects
   * its NOTICE reply lines until a short quiet period passes with no new
   * lines — service replies are a burst of NOTICEs with no explicit
   * terminator token in the protocol itself.
   */
  serviceCommand(target: string, command: string): Promise<string[]> {
    return new Promise((resolve) => {
      const collected: string[] = [];
      let quietTimer: NodeJS.Timeout | null = null;

      const finish = () => {
        clearTimeout(overallTimer);
        if (quietTimer) {
          clearTimeout(quietTimer);
        }
        unsubscribe();
        resolve(collected);
      };

      const overallTimer = setTimeout(finish, SERVICE_REPLY_TIMEOUT_MS);

      const unsubscribe = this.onLine((line) => {
        if (line.command !== "NOTICE" || prefixNick(line.prefix) !== target) {
          return;
        }
        collected.push(line.params.at(-1) ?? "");
        if (quietTimer) {
          clearTimeout(quietTimer);
        }
        quietTimer = setTimeout(finish, SERVICE_QUIET_PERIOD_MS);
      });

      this.send(`PRIVMSG ${target} :${command}`);
    });
  }

  destroy(): void {
    try {
      this.send("QUIT");
    } catch {
      // socket may already be closing
    }
    this.socket.destroy();
  }
}
