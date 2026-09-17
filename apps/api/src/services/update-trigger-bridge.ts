import net from "node:net";

/**
 * Client for the narrow host-side update-trigger bridge (see
 * installer/templates/deployment-platform-update-trigger.socket + @.service and
 * docs/SELF_UPDATE_ARCHITECTURE.md).
 *
 * The ENTIRE capability is: connect to one root-owned Unix socket to ask the
 * host to run exactly ONE updater tick immediately (instead of waiting for the
 * 15-minute timer). We deliberately send NO payload — the host bridge ignores
 * whatever arrives, so a byte here could never choose a command or a target
 * version. The authorization to APPLY still lives entirely in the
 * platform_update_apply_request row the /apply route writes (which the host
 * updater re-verifies); a bare tick with no pending request is a safe no-op.
 *
 * This is NOT the docker socket and grants no container/host control — only
 * "please check/apply now" through the updater that already owns that logic.
 */

export type TriggerUpdateTick = () => Promise<void>;

/** The socket path, overridable for tests / non-default layouts. */
export const UPDATE_TRIGGER_SOCKET_PATH =
  process.env.DP_UPDATE_TRIGGER_SOCKET || "/run/deployment-platform/trigger.sock";

/**
 * Builds a trigger function that resolves once the host has accepted the
 * connection (systemd's socket activation then starts one updater tick), and
 * rejects — without side effects — if the socket is missing/unreachable, so the
 * caller can report a clean error and leave pending state uncorrupted.
 */
export function createUpdateTriggerBridge(
  socketPath: string = UPDATE_TRIGGER_SOCKET_PATH,
  timeoutMs = 3000
): TriggerUpdateTick {
  return () =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = net.createConnection({ path: socketPath });

      const finish = (err?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* already closing */
        }
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      socket.setTimeout(timeoutMs);
      // Connecting IS the trigger. Send nothing; end our side immediately.
      socket.on("connect", () => finish());
      socket.on("timeout", () => finish(new Error(`update-trigger socket timed out after ${timeoutMs}ms`)));
      socket.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
}
