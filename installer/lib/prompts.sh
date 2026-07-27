#!/usr/bin/env bash
#
# prompts.sh — interactive input collection, and the strict validators
# every collected value (interactive or --flag) is run through before
# it is trusted anywhere else in the installer.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "prompts.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

# ============================================================
# Domain validation (section 29)
# ============================================================
#
# Deliberately strict and deliberately does not "helpfully" fix
# malformed input beyond lowercasing — a domain that needed a scheme,
# path, or port stripped was not what the operator meant to type, and
# guessing would be worse than asking again.

DOMAIN_LABEL_PATTERN='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'

validate_domain() {
  local raw="$1"
  local domain
  domain="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"

  if [ -z "$domain" ]; then
    echo "Domain must not be empty."
    return 1
  fi
  if [[ "$domain" == *"://"* ]]; then
    echo "Enter a bare domain, not a URL with a scheme (e.g. panel.example.com, not https://panel.example.com)."
    return 1
  fi
  if [[ "$domain" == *"/"* ]] || [[ "$domain" == *"?"* ]] || [[ "$domain" == *"#"* ]]; then
    echo "Domain must not contain a path, query string, or fragment."
    return 1
  fi
  if [[ "$domain" == *":"* ]]; then
    echo "Domain must not include a port."
    return 1
  fi
  if [[ "$domain" == *" "* ]] || [[ "$domain" =~ [[:space:]] ]]; then
    echo "Domain must not contain whitespace."
    return 1
  fi
  if [[ "$domain" =~ [\;\&\|\$\`\\\"\'\(\)\<\>\!\*] ]]; then
    echo "Domain contains characters that are not allowed."
    return 1
  fi
  if [[ "$domain" == \*.* ]]; then
    echo "Enter the base domain without a wildcard prefix (the installer adds the wildcard itself where needed)."
    return 1
  fi
  if [ "$domain" = "localhost" ] || [[ "$domain" == *.localhost ]]; then
    echo "localhost is not a valid public domain for this installer."
    return 1
  fi
  if [[ "$domain" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    echo "A raw IPv4 address is not accepted here — this installer targets a real domain with DNS records."
    return 1
  fi
  if [ "${#domain}" -gt 253 ]; then
    echo "Domain is too long."
    return 1
  fi

  local IFS='.'
  local -a labels=($domain)
  local label
  for label in "${labels[@]}"; do
    if [[ ! "$label" =~ $DOMAIN_LABEL_PATTERN ]]; then
      echo "\"$label\" is not a valid domain label."
      return 1
    fi
  done

  printf '%s' "$domain"
  return 0
}

validate_domain_pair() {
  local panel_domain="$1"
  local apps_domain="$2"

  if [ "$panel_domain" = "$apps_domain" ]; then
    echo "Panel domain and apps base domain must be different."
    return 1
  fi
  if [[ "$panel_domain" == *".$apps_domain" ]] || [ "$panel_domain" = "$apps_domain" ]; then
    echo "Panel domain must not fall under the apps wildcard (it would conflict with every app subdomain)."
    return 1
  fi
  return 0
}

# ============================================================
# IPv4 validation
# ============================================================

validate_ipv4() {
  local ip="$1"
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  local IFS='.'
  local -a octets=($ip)
  local octet
  for octet in "${octets[@]}"; do
    [ "$octet" -ge 0 ] && [ "$octet" -le 255 ] || return 1
  done
  return 0
}

# ============================================================
# Interactive prompts
# ============================================================

prompt_domain() {
  local label="$1"
  local domain=""
  local error=""
  while true; do
    prompt_output "${label}: "
    prompt_read domain
    if error="$(validate_domain "$domain" 2>&1)"; then
      printf '%s' "$error"
      return 0
    fi
    prompt_output "  ${error}"$'\n'
  done
}

# Hidden input with confirmation — never echoed, never written to
# shell history, never passed as a CLI argument. Label and confirmation
# label are visible (prompt_output); the password itself is read via
# prompt_read_secret (read -s) and only ever written to stdout, once,
# as this function's own final return value.
prompt_password() {
  local label="$1"
  local password="" confirm=""

  while true; do
    prompt_output "${label}: "
    prompt_read_secret password
    prompt_output $'\n'

    if [ "${#password}" -lt 12 ]; then
      prompt_output "  Password must be at least 12 characters."$'\n'
      continue
    fi

    prompt_output "Confirm ${label}: "
    prompt_read_secret confirm
    prompt_output $'\n'

    if [ "$password" != "$confirm" ]; then
      prompt_output "  Passwords did not match — try again."$'\n'
      continue
    fi

    printf '%s' "$password"
    return 0
  done
}

prompt_text() {
  local label="$1"
  local default_value="${2:-}"
  local value=""

  if [ -n "$default_value" ]; then
    prompt_output "${label} [${default_value}]: "
  else
    prompt_output "${label}: "
  fi
  prompt_read value

  if [ -z "$value" ] && [ -n "$default_value" ]; then
    value="$default_value"
  fi
  printf '%s' "$value"
}

prompt_choice() {
  local label="$1"
  shift
  local -a options=("$@")
  local index=1
  local option

  prompt_output "${label}"$'\n'
  for option in "${options[@]}"; do
    prompt_output "  ${index}) ${option}"$'\n'
    index=$((index + 1))
  done

  local choice=""
  while true; do
    prompt_output "Choice [1-${#options[@]}]: "
    prompt_read choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#options[@]}" ]; then
      printf '%s' "${options[$((choice - 1))]}"
      return 0
    fi
    prompt_output "  Enter a number between 1 and ${#options[@]}."$'\n'
  done
}
