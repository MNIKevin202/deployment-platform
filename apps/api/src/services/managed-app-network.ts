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
