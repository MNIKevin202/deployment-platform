import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import * as bcrypt from "bcryptjs";
import { isCollection, isScalar, parseDocument, YAMLMap } from "yaml";

/** Only ergochat/ergo-based apps get the IRC Settings tab. */
export function isIrcServerImage(image: string): boolean {
  let ref = image.trim();
  const at = ref.indexOf("@");
  if (at >= 0) {
    ref = ref.slice(0, at);
  }
  const lastSlash = ref.lastIndexOf("/");
  let name = lastSlash >= 0 ? ref.slice(lastSlash + 1) : ref;
  const colon = name.indexOf(":");
  if (colon >= 0) {
    name = name.slice(0, colon);
  }
  return name.toLowerCase() === "ergo";
}

export const IRC_CONFIG_PATH = "/ircd/ircd.yaml";
export const IRC_MOTD_PATH = "/ircd/ircd.motd";

export type IrcOperatorRole = "admin" | "moderator";

const ROLE_TO_CLASS: Record<IrcOperatorRole, string> = {
  admin: "server-admin",
  moderator: "chat-moderator"
};

const CLASS_TO_ROLE: Record<string, IrcOperatorRole> = {
  "server-admin": "admin",
  "chat-moderator": "moderator"
};

export interface IrcOperator {
  username: string;
  role: IrcOperatorRole;
  /** false when the class in the file doesn't match a known role — shown as-is, not editable via this UI. */
  knownRole: boolean;
}

/** Hashes a password the way Ergo expects (bcrypt) — verified independent of the cost factor `ergo genpasswd` uses. */
export async function hashOperatorPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

/** Reads the `opers:` section of an ircd.yaml document without exposing password hashes. */
export function parseOperators(configText: string): IrcOperator[] {
  const doc = parseDocument(configText);
  const opers = doc.get("opers", true);

  if (!(opers instanceof YAMLMap)) {
    return [];
  }

  const result: IrcOperator[] = [];

  for (const item of opers.items) {
    const username = isScalar(item.key) ? String(item.key.value) : String(item.key);
    const entry = item.value;
    const className =
      entry instanceof YAMLMap ? String(entry.get("class") ?? "") : "";
    const role = CLASS_TO_ROLE[className];

    result.push({
      username,
      role: role ?? "moderator",
      knownRole: Boolean(role)
    });
  }

  return result.sort((a, b) => a.username.localeCompare(b.username));
}

/** Adds a new operator or replaces an existing one's role/password, preserving the rest of the file (including comments). */
export function upsertOperator(
  configText: string,
  input: { username: string; passwordHash: string; role: IrcOperatorRole }
): string {
  const doc = parseDocument(configText);

  doc.setIn(["opers", input.username, "class"], ROLE_TO_CLASS[input.role]);
  doc.setIn(["opers", input.username, "password"], input.passwordHash);

  return doc.toString();
}

/** Removes an operator entry, preserving the rest of the file. Does nothing if the username isn't present. */
export function removeOperator(configText: string, username: string): string {
  const doc = parseDocument(configText);
  doc.deleteIn(["opers", username]);
  return doc.toString();
}

export interface IrcGeneralSettings {
  networkName: string;
  autoJoinChannels: string[];
  defaultChannelModes: string;
  maxChannelsPerClient: number;
  channelRegistrationEnabled: boolean;
  channelRegistrationOperatorOnly: boolean;
  maxChannelsPerAccount: number;
  accountRegistrationEnabled: boolean;
  allowRegistrationBeforeConnect: boolean;
  emailVerificationEnabled: boolean;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Reads the handful of server-wide settings the Settings tab exposes, each defaulting sensibly if the key isn't set. */
export function parseGeneralSettings(configText: string): IrcGeneralSettings {
  const doc = parseDocument(configText);

  // Unlike scalars, getIn() never unwraps a collection node into a plain JS
  // array/object — "collections are always returned intact" per its own
  // docs — so a raw YAMLSeq has to be resolved via toJSON() explicitly, or
  // Array.isArray() on it is always false and this silently reads as empty.
  const autoJoinNode = doc.getIn(["channels", "auto-join"], true);
  const autoJoin = isCollection(autoJoinNode) ? autoJoinNode.toJSON() : autoJoinNode;

  return {
    networkName: asString(doc.getIn(["network", "name"]), ""),
    autoJoinChannels: Array.isArray(autoJoin) ? autoJoin.filter((v): v is string => typeof v === "string") : [],
    defaultChannelModes: asString(doc.getIn(["channels", "default-modes"]), "+ntC"),
    maxChannelsPerClient: asNumber(doc.getIn(["channels", "max-channels-per-client"]), 100),
    channelRegistrationEnabled: asBoolean(doc.getIn(["channels", "registration", "enabled"]), true),
    channelRegistrationOperatorOnly: asBoolean(
      doc.getIn(["channels", "registration", "operator-only"]),
      false
    ),
    maxChannelsPerAccount: asNumber(doc.getIn(["channels", "registration", "max-channels-per-account"]), 15),
    accountRegistrationEnabled: asBoolean(doc.getIn(["accounts", "registration", "enabled"]), true),
    allowRegistrationBeforeConnect: asBoolean(
      doc.getIn(["accounts", "registration", "allow-before-connect"]),
      true
    ),
    emailVerificationEnabled: asBoolean(
      doc.getIn(["accounts", "registration", "email-verification", "enabled"]),
      false
    )
  };
}

/** Applies a partial set of general settings, preserving the rest of the file (including comments). */
export function updateGeneralSettings(
  configText: string,
  updates: Partial<IrcGeneralSettings>
): string {
  const doc = parseDocument(configText);

  if (updates.networkName !== undefined) {
    doc.setIn(["network", "name"], updates.networkName);
  }
  if (updates.autoJoinChannels !== undefined) {
    doc.setIn(["channels", "auto-join"], updates.autoJoinChannels);
  }
  if (updates.defaultChannelModes !== undefined) {
    doc.setIn(["channels", "default-modes"], updates.defaultChannelModes);
  }
  if (updates.maxChannelsPerClient !== undefined) {
    doc.setIn(["channels", "max-channels-per-client"], updates.maxChannelsPerClient);
  }
  if (updates.channelRegistrationEnabled !== undefined) {
    doc.setIn(["channels", "registration", "enabled"], updates.channelRegistrationEnabled);
  }
  if (updates.channelRegistrationOperatorOnly !== undefined) {
    doc.setIn(["channels", "registration", "operator-only"], updates.channelRegistrationOperatorOnly);
  }
  if (updates.maxChannelsPerAccount !== undefined) {
    doc.setIn(["channels", "registration", "max-channels-per-account"], updates.maxChannelsPerAccount);
  }
  if (updates.accountRegistrationEnabled !== undefined) {
    doc.setIn(["accounts", "registration", "enabled"], updates.accountRegistrationEnabled);
  }
  if (updates.allowRegistrationBeforeConnect !== undefined) {
    doc.setIn(["accounts", "registration", "allow-before-connect"], updates.allowRegistrationBeforeConnect);
  }
  if (updates.emailVerificationEnabled !== undefined) {
    doc.setIn(
      ["accounts", "registration", "email-verification", "enabled"],
      updates.emailVerificationEnabled
    );
  }

  return doc.toString();
}

interface ExecResult {
  exitCode: number;
  output: string;
}

/**
 * Runs a command inside the container and captures its stdout.
 *
 * Deliberately non-TTY: a PTY reflows output to a terminal width and
 * translates line endings, which silently corrupts anything larger than a
 * short status line (a multi-KB YAML file gets re-wrapped mid-line and comes
 * back structurally different from what's actually on disk). Without a TTY,
 * Docker instead multiplexes stdout/stderr behind 8-byte frame headers, so
 * the output has to be demuxed — that's what carries the file through byte
 * for byte.
 */
async function execInContainer(
  docker: Docker,
  containerId: string,
  cmd: string[]
): Promise<ExecResult> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false
  });

  const stream = await exec.start({ hijack: true, stdin: false, Tty: false });

  const stdoutChunks: Buffer[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  stderr.on("data", () => {});

  docker.modem.demuxStream(stream, stdout, stderr);

  await new Promise<void>((resolve, reject) => {
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });

  const inspectResult = await exec.inspect();

  return {
    exitCode: inspectResult.ExitCode ?? 1,
    output: Buffer.concat(stdoutChunks).toString("utf8")
  };
}

/** Reads a file from inside the container. Returns null if it doesn't exist (e.g. no MOTD set yet). */
export async function readFileFromContainer(
  docker: Docker,
  containerId: string,
  path: string
): Promise<string | null> {
  const result = await execInContainer(docker, containerId, ["cat", path]);

  if (result.exitCode !== 0) {
    return null;
  }

  return result.output;
}

/**
 * Writes a file inside the container, overwriting it entirely. First copies
 * whatever is currently there to `<path>.bak` (best-effort — a missing
 * source file, e.g. the very first write, is not an error) so a bad write
 * is always recoverable by hand, not just theoretically prevented.
 */
export async function writeFileToContainer(
  docker: Docker,
  containerId: string,
  path: string,
  content: string
): Promise<void> {
  await execInContainer(docker, containerId, [
    "sh",
    "-c",
    `cp ${JSON.stringify(path)} ${JSON.stringify(`${path}.bak`)} 2>/dev/null || true`
  ]);

  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ["sh", "-c", `cat > ${JSON.stringify(path)}`],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false
  });

  const stream = await exec.start({ hijack: true, stdin: true, Tty: false });

  await new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    stream.end(content, "utf8", () => resolve());
  });

  // Drain any stdout/stderr so the exec can complete cleanly, then wait for
  // the process to actually exit before inspecting its result.
  await new Promise<void>((resolve) => {
    stream.on("data", () => {});
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
  });

  const inspectResult = await exec.inspect();

  if ((inspectResult.ExitCode ?? 1) !== 0) {
    throw new Error(`Unable to write ${path} inside the container`);
  }
}

/**
 * Reloads Ergo's config without disconnecting anyone — the same as the
 * server's own /REHASH command, sent from outside instead of over IRC.
 */
export async function rehashIrcServer(docker: Docker, containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.kill({ signal: "SIGHUP" });
}
