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

# Deliberately a short window, not a real "wait for DNS" loop: real
# propagation can take minutes to hours, which is far longer than an
# installer should hold a terminal open. This only covers the common
# case where the operator created the records moments ago. If it
# expires, the installer still saves state and exits with instructions
# exactly as it did before.
DNS_CHECK_MAX_ATTEMPTS=6
DNS_CHECK_DELAY_SECONDS=10

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

# ============================================================
# Wildcard probe naming
# ============================================================
#
# There is no single hostname that proves a *.apps wildcard record
# works, so a probe child name is resolved instead. That probe must be
# FRESH every time: a fixed probe name (the old
# "installer-dns-check.<apps>") gets an NXDOMAIN answer negatively
# cached by the resolver whenever it is queried before the wildcard
# record exists — and then every retry re-asks for the exact same
# cached-negative name, reporting "DNS not ready" long after the
# wildcard genuinely works. A never-before-queried label can't be in
# anyone's negative cache.

# The most recent probe hostname check_dns_ready tested — exposed for
# diagnostics and tests. Never a secret: it is built from the epoch,
# process IDs, and $RANDOM only.
DNS_LAST_PROBE_HOST=""

# Entropy suffix for a probe label. Split out from
# generate_dns_probe_label so tests can override just this function for
# deterministic labels.
#
# Callers invoke the generator through command substitution — a
# subshell — which rules out two tempting uniqueness sources: a shell
# counter (the increment dies with the subshell) and $RANDOM alone
# (consecutive subshells inherit the SAME parent RNG state, so two
# probes in the same second would come out identical). The
# `sh -c 'echo $$'` component fixes that: it is a freshly spawned
# process's own PID, different on every single call regardless of
# subshell inheritance. Epoch, parent pid, helper pid, and $RANDOM are
# combined so no single source is relied on; no uuidgen dependency, no
# user data, digits-and-hyphens only.
_dns_probe_entropy() {
  printf '%s-%s-%s-%s' "$(date -u +%s)" "$$" "$(sh -c 'echo $$')" "$RANDOM"
}

# Prints one fresh, syntactically valid DNS label (the label only — the
# caller appends ".${apps_domain}"). Always lowercase alphanumerics and
# hyphens, starts and ends alphanumeric, hard-capped at 63 characters
# (the realistic length is ~40, but the cap makes the guarantee
# unconditional).
generate_dns_probe_label() {
  printf '%s' "dp-check-$(_dns_probe_entropy)" | cut -c1-63
}

# ============================================================
# Resolution
# ============================================================

# Filters $1 (one candidate per line) down to valid IPv4 addresses,
# one per line. Returns 1 if nothing valid was present.
_emit_valid_ipv4s() {
  local raw="$1"
  local line emitted=1
  while IFS= read -r line; do
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] || continue
    if validate_ipv4 "$line"; then
      printf '%s\n' "$line"
      emitted=0
    fi
  done <<EOF
$raw
EOF
  return "$emitted"
}

# Prints every IPv4 A record observed for $1, one per line, trying each
# available resolver tool IN TURN until one produces at least one valid
# address: getent, then dig, then host. Unlike the old
# if/elif chain, an installed-but-empty (or malformed) getent answer no
# longer suppresses dig/host — a resolver tool returning nothing is a
# reason to try the next tool, not proof the record is absent.
resolve_domain_ipv4_all() {
  local domain="$1"
  local output

  if command -v getent >/dev/null 2>&1; then
    output="$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' || true)"
    if _emit_valid_ipv4s "$output"; then
      return 0
    fi
  fi
  if command -v dig >/dev/null 2>&1; then
    output="$(dig +short A "$domain" 2>/dev/null || true)"
    if _emit_valid_ipv4s "$output"; then
      return 0
    fi
  fi
  if command -v host >/dev/null 2>&1; then
    output="$(host -t A "$domain" 2>/dev/null | awk '/has address/ {print $4}' || true)"
    if _emit_valid_ipv4s "$output"; then
      return 0
    fi
  fi
  return 1
}

# Returns 0 when ANY observed A record for $1 equals $2. A hostname
# with multiple legitimate A records must not fail readiness just
# because resolver ordering put a different record first.
domain_resolves_to_expected_ip() {
  local domain="$1"
  local expected_ip="$2"
  local resolved ip
  resolved="$(resolve_domain_ipv4_all "$domain" || true)"
  [ -n "$resolved" ] || return 1
  while IFS= read -r ip; do
    if [ "$ip" = "$expected_ip" ]; then
      return 0
    fi
  done <<EOF
$resolved
EOF
  return 1
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

# Returns 0 if the panel record and a FRESH wildcard probe both resolve
# to the server's own public IP, 1 otherwise. A new probe label is
# generated on every single invocation — the initial check and each
# retry each ask for a hostname no resolver has ever been asked about,
# so an earlier attempt's negatively cached NXDOMAIN can never poison a
# later one. Never used as a security boundary (DNS can lie or be
# rebound) — only as an operator convenience gate before attempting
# public TLS verification, which is where a DNS mismatch would actually
# be caught for real.
check_dns_ready() {
  local panel_domain="$1"
  local apps_domain="$2"
  local server_ip="$3"

  local probe_label probe_host
  probe_label="$(generate_dns_probe_label)"
  probe_host="${probe_label}.${apps_domain}"
  DNS_LAST_PROBE_HOST="$probe_host"

  local panel_ok=1 probe_ok=1
  if domain_resolves_to_expected_ip "$panel_domain" "$server_ip"; then
    panel_ok=0
  fi
  if domain_resolves_to_expected_ip "$probe_host" "$server_ip"; then
    probe_ok=0
  fi

  if [ "$panel_ok" -eq 0 ] && [ "$probe_ok" -eq 0 ]; then
    return 0
  fi

  # Failure diagnostics: what was actually observed, per hostname —
  # bounded, secret-free (hostnames + IPs only), and only on the
  # failure path, so the success path costs no extra queries.
  local panel_seen probe_seen
  panel_seen="$(resolve_domain_ipv4_all "$panel_domain" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//' || true)"
  [ -n "$panel_seen" ] || panel_seen="(none)"
  probe_seen="$(resolve_domain_ipv4_all "$probe_host" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//' || true)"
  [ -n "$probe_seen" ] || probe_seen="(none)"
  log_info "DNS check not ready:"
  log_info "  ${panel_domain} -> ${panel_seen}"
  log_info "  ${probe_host} -> ${probe_seen}"
  log_info "  expected -> ${server_ip}"
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

  # Bounded, visible re-check window. Previously this was a single silent
  # check that immediately exited with instructions — if the operator had
  # just created the records, they had to notice, re-read, and re-run for
  # what was often a few seconds of propagation. The eventual
  # exit-and-resume behaviour below is unchanged; this only gives
  # propagation a short, honest, watchable chance first.
  if [ "$server_ip" != "<server IPv4>" ]; then
    local attempt=1
    local start_epoch
    start_epoch="$(date -u +%s)"
    local elapsed=0
    log_info "Waiting for ${panel_domain} and a fresh *.${apps_domain} wildcard probe to resolve to ${server_ip}"
    # Each attempt: log, then check IMMEDIATELY (a fresh probe name is
    # generated inside check_dns_ready every call), then sleep only if
    # another attempt remains — no pointless delay before the first
    # check and none after the last, so 6 attempts cost at most ~5
    # sleeps, not 6.
    while [ "$attempt" -le "$DNS_CHECK_MAX_ATTEMPTS" ]; do
      elapsed=$(( $(date -u +%s) - start_epoch ))
      progress_report_attempt \
        "Waiting for DNS: ${panel_domain} + wildcard probe -> ${server_ip}" \
        "$attempt" "$DNS_CHECK_MAX_ATTEMPTS" "$elapsed" \
        "$DNS_CHECK_DELAY_SECONDS"
      if check_dns_ready "$panel_domain" "$apps_domain" "$server_ip"; then
        elapsed=$(( $(date -u +%s) - start_epoch ))
        log_pass "DNS now resolves correctly for $panel_domain and *.${apps_domain} (after ${elapsed}s)."
        return 0
      fi
      attempt=$((attempt + 1))
      if [ "$attempt" -le "$DNS_CHECK_MAX_ATTEMPTS" ]; then
        sleep "$DNS_CHECK_DELAY_SECONDS"
      fi
    done
    log_warn "DNS still does not resolve to ${server_ip} after ${DNS_CHECK_MAX_ATTEMPTS} checks (${elapsed}s). This is normal if the records were only just created — propagation can take much longer than this installer should wait."
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
