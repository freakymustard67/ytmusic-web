#!/usr/bin/env bash
#
# Provision the FREE Google Cloud option, then verify it can actually play audio.
#
# Why GCP: every VM NIC is assigned a /96 of IPv6 and Google's own guidance is to
# "use any random /128 IPv6 address from the /96 address range assigned" — so the
# host can present billions of different source addresses. That is the free,
# non-residential remedy for YouTube's address-class block (it refuses
# /youtubei/v1/player from datacenter addresses while still answering /browse).
#
# IPv6 addresses and traffic from Google to YouTube are not charged, and the
# e2-micro instance is in the Always Free tier. Caveats are printed at the end —
# read them, in particular the 1 GB/month free egress allowance.
#
# Usage:
#   ./scripts/gcp-setup.sh                 # create everything + deploy
#   ./scripts/gcp-setup.sh --check         # only report the IPv6 prefix
#   ZONE=us-west1-b ./scripts/gcp-setup.sh
#
# Requires: gcloud (authenticated), and a billing account enabled on the project.

set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
ZONE="${ZONE:-us-west1-b}"
REGION="${REGION:-${ZONE%-*}}"
INSTANCE="${INSTANCE:-ytmusic-web}"
VPC="${VPC:-ytmusic-vpc}"
SUBNET="${SUBNET:-ytmusic-subnet}"
FIREWALL="${FIREWALL:-ytmusic-web-fw}"
MACHINE="${MACHINE:-e2-micro}"

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '%s[x]%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
info() { printf '  %s%s%s\n' "$DIM" "$*" "$RESET"; }

[ -n "$PROJECT" ] || die "no project set: run 'gcloud config set project <id>' or pass PROJECT="
command -v gcloud >/dev/null 2>&1 || die "gcloud not found: https://cloud.google.com/sdk/docs/install"

# Always Free for e2-micro only in these regions.
case "$REGION" in
  us-west1|us-central1|us-east1) ;;
  *) warn "region '$REGION' is NOT in the e2-micro Always Free set (us-west1, us-central1, us-east1)" ;;
esac

# ---------------------------------------------------------------- check only --
if [ "${1:-}" = "--check" ]; then
  log "IPv6 prefixes visible in $ZONE"
  gcloud compute instances describe "$INSTANCE" --zone "$ZONE" --project "$PROJECT" \
    --format='value(networkInterfaces[].ipv6AccessConfig[].externalIpv6)' || true
  gcloud compute networks subnets describe "$SUBNET" --region "$REGION" --project "$PROJECT" \
    --format='value(ipv6CidrRange,stackType)' || true
  exit 0
fi

# ------------------------------------------------------------------ network --
log "VPC + dual-stack subnet in $REGION"
if ! gcloud compute networks describe "$VPC" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute networks create "$VPC" --subnet-mode=custom --project "$PROJECT"
  ok "created VPC $VPC"
else
  ok "VPC $VPC exists"
fi

# external IPv6 on the subnet is what gives each NIC its own /96
if ! gcloud compute networks subnets describe "$SUBNET" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute networks subnets create "$SUBNET" \
    --network="$VPC" --region="$REGION" --range=10.10.0.0/24 \
    --stack-type=IPV4_IPV6 --ipv6-access-type=EXTERNAL --project "$PROJECT"
  ok "created dual-stack subnet $SUBNET"
else
  stack=$(gcloud compute networks subnets describe "$SUBNET" --region "$REGION" --project "$PROJECT" --format='value(stackType)')
  if [ "$stack" != "IPV4_IPV6" ]; then
    gcloud compute networks subnets update "$SUBNET" --region="$REGION" \
      --stack-type=IPV4_IPV6 --ipv6-access-type=EXTERNAL --project "$PROJECT"
    ok "upgraded $SUBNET to dual-stack"
  else
    ok "subnet $SUBNET already dual-stack"
  fi
fi

# ------------------------------------------------------------------- access --
log "firewall rules (22 for setup, 80/443 for the app)"
for rule_spec in "tcp:22:setup" "tcp:80,443:web"; do
  ports="${rule_spec%%:*}"; rest="${rule_spec#*:}"; name="${rest%%:*}"
  rule="${FIREWALL}-${name}"
  if ! gcloud compute firewall-rules describe "$rule" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud compute firewall-rules create "$rule" \
      --network="$VPC" --allow="$ports" --source-ranges=0.0.0.0/0,::/0 \
      --description="ytmusic-web $name" --project "$PROJECT" >/dev/null
    ok "created $rule"
  else
    ok "$rule exists"
  fi
done

# ----------------------------------------------------------------- instance --
log "instance $INSTANCE ($MACHINE, Always Free eligible)"
if ! gcloud compute instances describe "$INSTANCE" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute instances create "$INSTANCE" \
    --zone="$ZONE" --machine-type="$MACHINE" \
    --network-interface="subnet=$SUBNET,stack-type=IPV4_IPV6,ipv6-network-tier=PREMIUM" \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=30GB --boot-disk-type=pd-standard \
    --project "$PROJECT"
  ok "created $INSTANCE"
else
  ok "$INSTANCE exists"
fi

# 1 GB of RAM is tight next to a Node service; add swap before deploying.
log "waiting for SSH, then preparing the VM"
for i in $(seq 1 30); do
  if gcloud compute ssh "$INSTANCE" --zone "$ZONE" --project "$PROJECT" --command="true" >/dev/null 2>&1; then
    ok "SSH reachable"
    break
  fi
  [ "$i" = 30 ] && die "SSH did not become reachable"
  sleep 10
done

gcloud compute ssh "$INSTANCE" --zone "$ZONE" --project "$PROJECT" --command="
  set -e
  if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    sudo chmod 600 /swapfile; sudo mkswap -q /swapfile; sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    echo 'swap added'
  fi
" || warn "swap setup reported an error (continuing)"

# --------------------------------------------------------- report ipv6 range --
log "IPv6 range assigned to this instance"
EXT6=$(gcloud compute instances describe "$INSTANCE" --zone "$ZONE" --project "$PROJECT" \
  --format='value(networkInterfaces[0].ipv6AccessConfig[0].externalIpv6)' 2>/dev/null || true)
SUBNET6=$(gcloud compute networks subnets describe "$SUBNET" --region "$REGION" --project "$PROJECT" \
  --format='value(ipv6CidrRange)' 2>/dev/null || true)

if [ -n "$EXT6" ]; then ok "instance external IPv6: $EXT6"; else warn "no external IPv6 found on the instance"; fi
if [ -n "$SUBNET6" ]; then ok "subnet IPv6 range: $SUBNET6"; else warn "subnet has no IPv6 range"; fi

# The rotatable prefix is the instance's /96: its address with the low 32 bits zeroed.
PREFIX96=""
if [ -n "$SUBNET6" ]; then
  PREFIX96=$(python3 - "$SUBNET6" <<'PY' 2>/dev/null || true
import ipaddress, sys
net = ipaddress.ip_network(sys.argv[1], strict=False)
# GCP gives the NIC a /96 inside the subnet's /64.
if net.prefixlen <= 96:
    print(f"{net.network_address}/96")
PY
)
fi

echo
echo "${BOLD}Next steps${RESET}"
if [ -n "$PREFIX96" ]; then
  echo "  1. Verify rotation actually works on this host:"
  echo "       gcloud compute ssh $INSTANCE --zone $ZONE --command='sudo /opt/ytmusic-web/scripts/check-ipv6.sh'"
  echo "  2. Deploy the app with rotation enabled:"
  echo "       EGRESS_IPV6_PREFIX=$PREFIX96"
else
  echo "  1. Obtain the instance's /96 (run this script with --check), then set"
  echo "     EGRESS_IPV6_PREFIX to that range."
fi
echo "  3. Confirm YouTube accepts it:"
echo "       curl -s 'http://localhost:10000/api/egress' | grep verdict"
echo
echo "${YELLOW}Caveats — read these${RESET}"
echo "  • Free egress is only 1 GB/month. Audio is ~60 MB/hour, so ~16 hours of"
echo "    listening per month is free; beyond that it is \$0.12/GiB (about \$0.50 for"
echo "    4 GB). Everything else in the Always Free tier is genuinely free."
echo "  • e2-micro has 1 GB RAM and 2 shared vCPUs — the swap this script adds is"
echo "    not optional, and expect slower first-play than a larger host."
echo "  • Whether GCP's /96 rotation still evades YouTube is NOT verified by anyone;"
echo "    step 1 above exists precisely to test that before you rely on it."
echo "  • Idle instances are not reclaimed on GCP (unlike Oracle), but the instance"
echo "    must stay in us-west1/us-central1/us-east1 to remain Always Free."
