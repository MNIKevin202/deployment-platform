/**
 * The Docker networking every managed app container is created with.
 *
 * Kept in ONE place because all three container-creation paths (app creation,
 * redeploy, GitHub deploy) must stay in lockstep: an app that is created
 * differently from how it is redeployed silently changes behaviour on the next
 * deploy.
 */

/** The managed-app Docker network every app container is attached to. */
export const MANAGED_APPS_NETWORK = "deployment-apps";

/**
 * Clears the container's DNS search list. "." is Docker's documented sentinel
 * for "no search domain" — the API equivalent of `docker run --dns-search=.`.
 */
export const CLEARED_DNS_SEARCH = ".";

/**
 * Networking for a managed app container: the shared apps network, plus an
 * explicitly EMPTY DNS search list.
 *
 * Clearing the search list is load-bearing, not cosmetic. Managed apps reach
 * each other (and their databases) by container name on the shared network —
 * `app-<name>`, which the panel advertises as the internal address. That name
 * is answered by Docker's embedded DNS at 127.0.0.11.
 *
 * By default Docker copies the HOST's /etc/resolv.conf search list into every
 * container. On a host running Tailscale — or any VPN/DHCP that publishes a
 * search domain — containers inherit something like:
 *
 *     nameserver 127.0.0.11
 *     search tail77ad1d.ts.net
 *     options edns0 trust-ad ndots:0
 *
 * The resolver then appends that suffix and asks for
 * `app-clovasuite-db.tail77ad1d.ts.net`, which the embedded DNS does not own,
 * so it forwards upstream and gets NXDOMAIN — the bare container name is never
 * answered. Every app-to-database lookup fails with ENOTFOUND even though both
 * containers are on the same network with correct IPs. Externally-qualified
 * names keep working (they are forwarded upstream and resolve normally), which
 * is exactly why this hides until something resolves a container name.
 *
 * Clearing the search list leaves `nameserver 127.0.0.11` untouched, so
 * container-name lookups AND external lookups both resolve.
 */
export function managedAppNetworkHostConfig(): {
  NetworkMode: string;
  DnsSearch: string[];
} {
  return {
    NetworkMode: MANAGED_APPS_NETWORK,
    DnsSearch: [CLEARED_DNS_SEARCH]
  };
}

/** The narrow Docker surface the DNS-registration guarantee needs. */
export interface ManagedDnsOps {
  inspectContainer(id: string): Promise<{ networkAddresses?: Record<string, string> }>;
  refreshNetworkEndpoint(containerId: string, networkName: string): Promise<void>;
}

interface ManagedDnsLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

/**
 * Resolves a name against the managed-app network's embedded DNS — the same
 * resolver Caddy and every app container use. A fresh c-ares Resolver per call
 * issues a DIRECT query, so it is not affected by the container's own
 * resolv.conf search list, and never returns a cached answer.
 */
async function resolveOnManagedNetwork(hostname: string): Promise<string[]> {
  const { Resolver } = await import("node:dns/promises");
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  return resolver.resolve4(hostname);
}

/**
 * Guarantees a just-started managed container is resolvable BY NAME on the
 * managed-app network, repairing the registration if it is not.
 *
 * Apps address each other and their databases as `app-<name>` — the internal
 * address the panel advertises. That depends on Docker registering the
 * container's name with the embedded DNS at creation, and on some hosts that
 * registration silently does not happen: the container is attached and has an
 * IP (it appears in `docker network inspect`), external names resolve fine, but
 * a bare container-name lookup returns SERVFAIL forever. Every app->database
 * connection then fails while the platform looks healthy.
 *
 * Disconnecting and reconnecting the endpoint makes the daemon rebuild it and
 * register the name, which is the same repair `refreshManagedEndpoint` performs
 * after a rename — applied here at creation, where the fault actually appears.
 *
 * Deliberately conservative:
 *   - Only ever repairs a container already attached to the managed-app network;
 *     it never force-attaches and never touches another network.
 *   - Only refreshes when the name does NOT already resolve to this container's
 *     own IP, so a healthy host pays one cheap DNS query and nothing moves.
 *   - Best-effort: every failure is logged and swallowed. A container that
 *     works is never broken by an attempt to make DNS tidy; the caller's own
 *     health verification remains the real gate.
 */
export async function ensureManagedNameResolves(params: {
  ops: ManagedDnsOps;
  containerId: string;
  containerName: string;
  logger?: ManagedDnsLogger;
  logContext?: Record<string, unknown>;
  /** Injected in tests; defaults to the real embedded-DNS lookup. */
  resolveHostAddresses?: (hostname: string) => Promise<string[]>;
}): Promise<{ resolved: boolean; refreshed: boolean }> {
  const {
    ops,
    containerId,
    containerName,
    logger,
    logContext = {},
    resolveHostAddresses = resolveOnManagedNetwork
  } = params;

  const context = { ...logContext, containerId, containerName, network: MANAGED_APPS_NETWORK };

  try {
    const before = await ops.inspectContainer(containerId);
    const expectedIp = before.networkAddresses?.[MANAGED_APPS_NETWORK];
    if (!expectedIp) {
      // Not on the managed-app network (or no address yet) — nothing to repair,
      // and force-attaching is never this function's job.
      return { resolved: false, refreshed: false };
    }

    // Already registered? Then leave the endpoint completely alone.
    try {
      const addresses = await resolveHostAddresses(containerName);
      if (addresses.includes(expectedIp)) {
        return { resolved: true, refreshed: false };
      }
    } catch {
      // Lookup failed (SERVFAIL/timeout) — that is exactly the fault we repair.
    }

    logger?.info(context, "Container name does not resolve to its own IP; refreshing endpoint to re-register DNS");
    await ops.refreshNetworkEndpoint(containerId, MANAGED_APPS_NETWORK);

    // The IP can change across a reconnect, so re-read it before re-checking.
    const after = await ops.inspectContainer(containerId);
    const repairedIp = after.networkAddresses?.[MANAGED_APPS_NETWORK];
    if (!repairedIp) {
      logger?.warn(context, "No managed-network address after endpoint refresh");
      return { resolved: false, refreshed: true };
    }

    try {
      const addresses = await resolveHostAddresses(containerName);
      const resolved = addresses.includes(repairedIp);
      logger?.info({ ...context, repairedIp, addresses, resolved }, "DNS registration re-checked after endpoint refresh");
      return { resolved, refreshed: true };
    } catch (error) {
      logger?.warn(
        { ...context, repairedIp, error: error instanceof Error ? error.message : String(error) },
        "Container name still does not resolve after endpoint refresh"
      );
      return { resolved: false, refreshed: true };
    }
  } catch (error) {
    // Never let a best-effort DNS repair fail a deployment.
    logger?.warn(
      { ...context, error: error instanceof Error ? error.message : String(error) },
      "DNS registration check failed; continuing"
    );
    return { resolved: false, refreshed: false };
  }
}
