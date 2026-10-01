#!/usr/bin/env bash
#
# Can this host source traffic from arbitrary addresses inside its IPv6 prefix?
#
# That single property decides whether the free, non-residential remedy for
# YouTube's address-class block is available here. Many providers hand out a
# single /128 (useless); a few route a whole /64 that you may address freely.
#
# Usage:  ./scripts/check-ipv6.sh
# Exit 0 when rotation is possible, 1 when it is not.

set -uo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
info() { printf '  %s%s%s\n' "$DIM" "$*" "$RESET"; }

echo "${BOLD}IPv6 rotation capability check${RESET}"
echo

# ---- 1. does the host have IPv6 at all? -------------------------------------
addr6=$(ip -6 addr show scope global 2>/dev/null | awk '/inet6/{print $2}' | head -1)
if [ -z "$addr6" ]; then
  bad "no global IPv6 address on this host"
  info "Providers with no IPv6 cannot rotate. Pick another host."
  exit 1
fi
ok "global IPv6 address: $addr6"

# ---- 2. is a routed prefix present? ----------------------------------------
prefixes=$(ip -6 route show 2>/dev/null | awk '/^[0-9a-f:]/ && !/^(fe80|ff00|default|unreachable)/ {print $1}' | sort -u)
if [ -z "$prefixes" ]; then
  warn "no non-default IPv6 route found (only a link-local or default route)"
  info "A single address with no routed prefix cannot be rotated within."
  exit 1
fi
info "routes: $(echo "$prefixes" | tr '\n' ' ')"

# Rotation needs a range with plenty of addresses. GCP assigns a /96 per NIC and
# AWS can delegate a /80, so those qualify alongside the usual /64. A /124 (16
# addresses, DigitalOcean) or a hand-assigned /128 does not.
best=""; best_bits=0
for p in $prefixes; do
  bits="${p##*/}"
  case "$bits" in
    ''|*[!0-9]*) continue ;;
  esac
  if [ "$bits" -le 96 ]; then
    if [ "$best_bits" -eq 0 ] || [ "$bits" -lt "$best_bits" ]; then
      best="$p"; best_bits="$bits"
    fi
  fi
done
if [ -z "$best" ]; then
  bad "no routed prefix wide enough to rotate within"
  info "Found: $(echo "$prefixes" | tr '\n' ' ')"
  info "A routed /64 (typical VPS), or GCP's per-NIC /96, or a delegated AWS /80 all work."
  info "A single /128, or a /124 with 16 addresses, does not."
  exit 1
fi
if [ "$best_bits" -gt 80 ]; then
  warn "prefix /$best_bits gives $((2 ** (128 - best_bits))) addresses — enough, but small"
fi
ok "routed prefix: $best"

# ---- 3. can we source from an arbitrary address in that prefix? -------------
# Derive the network portion and synthesise a random interface address.
net="${best%%/*}"
net="${net%::}"
rand=$(printf '%04x:%04x:%04x:%04x' \
  $((RANDOM)) $((RANDOM)) $((RANDOM)) $((RANDOM)))
candidate="${net}::${rand}"
info "testing source address: $candidate"

upstream="https://api64.ipify.org"

# Preferred: bind the source address per-connection, no root and no interface change.
if command -v curl >/dev/null 2>&1; then
  seen=$(curl -s -6 --max-time 12 --interface "$candidate" "$upstream" 2>/dev/null || true)
  if [ -n "$seen" ] && [ "$seen" != "${addr6%/*}" ]; then
    ok "arbitrary source address works WITHOUT configuration"
    info "observed egress: $seen"
    echo
    echo "${BOLD}Result:${RESET} ${GREEN}rotation is possible${RESET}"
    echo "  Set EGRESS_IPV6_PREFIX=$best and restart the service."
    exit 0
  fi
fi

# Fallback: the address may need to be bound to the interface first (needs root).
if [ "$(id -u)" != "0" ]; then
  warn "could not source from an unconfigured address, and we are not root"
  info "Re-run with sudo to test whether binding the address first helps."
  exit 1
fi

iface=$(ip -6 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)
if [ -z "$iface" ]; then
  bad "could not determine the outbound interface"
  exit 1
fi
info "binding $candidate to $iface and retrying"

if ip -6 addr add "$candidate/$best_bits" dev "$iface" 2>/dev/null; then
  ok "address added to $iface"
else
  bad "could not add $candidate to $iface — the prefix is not yours to address"
  info "This is the AWS/GCP/Oracle/Azure pattern: a routed prefix is not provided."
  exit 1
fi

seen=$(curl -s -6 --max-time 12 --interface "$candidate" "$upstream" 2>/dev/null || true)
ip -6 addr del "$candidate/$best_bits" dev "$iface" 2>/dev/null || true

if [ -n "$seen" ]; then
  ok "arbitrary source address works once bound"
  info "observed egress: $seen"
  echo
  echo "${BOLD}Result:${RESET} ${GREEN}rotation is possible${RESET}"
  echo "  Set EGRESS_IPV6_PREFIX=$best and restart the service."
  echo "  The service emits these as source addresses, so no per-address"
  echo "  'ip addr add' is needed once the prefix is routed."
  exit 0
fi

bad "traffic from $candidate did not leave the host"
info "The prefix is routed but not usable for sourcing. Rotation is not available here."
exit 1
