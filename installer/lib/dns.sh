#!/usr/bin/env bash
#
# dns.sh — DNS readiness flow (section 6). Detects the server's public
# IPv4 address from multiple bounded, independent sources (never just
# one), explains the DNS records the operator needs to create, and
# checks whether they already resolve correctly. This never blocks
# local setup that has already completed — only the final public TLS
# verification stage waits on DNS, and only unless the operator
# explicitly opts to continue without it.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "dns.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

# Multiple independent providers so one outage doesn't block the whole
# flow — each call is bounded (connect + total timeout) and its output
# is validated as a plausible IPv4 address before being trusted.
PUBLIC_IP_SOURCES=(
  "https://api.ipify.org"
  "https://ifconfig.me/ip"
  "https://icanhazip.com"
)

detect_public_ipv4() {
  local source ip
  for source in "${PUBLIC_IP_SOURCES[@]}"; do
    ip="$(curl -fsSL --connect-timeout 5 --max-time 10 "$source" 2>/dev/null | tr -d '[:space:]')"
    if validate_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  done
  return 1
}

resolve_domain_to_ip() {
  local domain="$1"
  if command -v getent >/dev/null 2>&1; then
    getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | head -n 1
  elif command -v host >/dev/null 2>&1; then
    host -t A "$domain" 2>/dev/null | awk '/has address/ {print $4; exit}'
  elif command -v dig >/dev/null 2>&1; then
    dig +short A "$domain" 2>/dev/null | head -n 1
  fi
}

print_required_dns_records() {
  local panel_domain="$1"
  local apps_domain="$2"
  local server_ip="$3"

  echo
  echo "Create these DNS records, then rerun the installer:"
  echo
  printf '  %-28s A     %s\n' "$panel_domain" "$server_ip"
  printf '  %-28s A     %s\n' "*.${apps_domain}" "$server_ip"
  echo
  echo "Then rerun:"
  echo "  sudo ./installer/install.sh --resume"
  echo
}

# Returns 0 if both records already resolve to the server's own public
# IP, 1 otherwise. Never used as a security boundary (DNS can lie or be
# rebound) — only as an operator convenience gate before attempting
# public TLS verification, which is where a DNS mismatch would actually
# be caught for real.
check_dns_ready() {
  local panel_domain="$1"
  local apps_domain="$2"
  local server_ip="$3"

  local panel_resolved apps_probe_resolved
  panel_resolved="$(resolve_domain_to_ip "$panel_domain")"
  # There's no single hostname to resolve for a wildcard record, so a
  # representative probe label is checked instead — this is advisory
  # only, real verification happens against the actual panel domain.
  apps_probe_resolved="$(resolve_domain_to_ip "installer-dns-check.${apps_domain}")"

  if [ "$panel_resolved" = "$server_ip" ] && [ "$apps_probe_resolved" = "$server_ip" ]; then
    return 0
  fi
  return 1
}

run_dns_readiness_flow() {
  log_stage "DNS READINESS"
  local panel_domain="$1"
  local apps_domain="$2"
  local allow_continue_without_dns="$3"

  local server_ip
  if ! server_ip="$(detect_public_ipv4)"; then
    log_warn "Could not automatically detect this server's public IPv4 address (all lookup sources failed or were unreachable). You will need to find it yourself (e.g. 'ip -4 addr' or your hosting provider's dashboard)."
    server_ip="<server IPv4>"
  else
    log_pass "Detected public IPv4: $server_ip"
  fi

  if [ "$server_ip" != "<server IPv4>" ] && check_dns_ready "$panel_domain" "$apps_domain" "$server_ip"; then
    log_pass "DNS already resolves correctly for $panel_domain and *.${apps_domain}."
    return 0
  fi

  print_required_dns_records "$panel_domain" "$apps_domain" "$server_ip"

  if [ "$allow_continue_without_dns" -eq 1 ]; then
    log_warn "Continuing without confirmed DNS, per --continue-without-dns / operator choice. Public TLS verification may fail until DNS propagates."
    return 0
  fi

  state_set_stage "dns-pending"
  log_action "DNS is not ready yet. Local setup so far has been preserved — nothing is rolled back for incomplete DNS propagation. Create the records above, wait for them to propagate, then run:"
  log_action "  sudo ./installer/install.sh --resume"
  exit 0
}
