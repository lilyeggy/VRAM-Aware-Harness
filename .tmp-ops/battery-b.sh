set -u
ROOT=/home/cxr/agent-harness-mt
BUN=/home/cxr/.bun/bin/bun
export HARNESS_BASE_URL=http://127.0.0.1:3100
export HARNESS_API_KEY=live-flow-key-2026
export HARNESS_BOOTSTRAP_API_KEY=live-flow-key-2026
export HARNESS_SMOKE_INVITE_CODE=lab-harness-2026
export HARNESS_PHASE5_SUDO_PASSWORD=123456
export HARNESS_PHASE5_LABEL=faultopsB-$(date +%s)
cd "$ROOT"
echo "=== STEP phase5-worker-crash $(date +%H:%M:%S)"
$BUN run scripts/phase5-worker-crash.ts 2>&1 | tail -8
echo "=== STEP tls-proxy-https $(date +%H:%M:%S)"
setsid nohup $BUN run scripts/dev-tls-proxy.ts > /tmp/tls-proxy.log 2>&1 &
sleep 3
cat /tmp/tls-proxy.log | tail -3
NODE_EXTRA_CA_CERTS=/tmp/harness-tls/cert.pem HARNESS_BASE_URL=https://127.0.0.1:8443 $BUN run scripts/p0-e2e-smoke.ts 2>&1 | tail -4
pkill -f dev-tls-proxy.ts || true
echo
echo BATTERY_B_DONE
