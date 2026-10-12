set -u
ROOT=/home/cxr/agent-harness-mt
BUN=/home/cxr/.bun/bin/bun
CERTDIR=/tmp/harness-tls
mkdir -p "$CERTDIR"
if [ -f "$CERTDIR/cert.pem" ] && [ -f "$CERTDIR/key.pem" ]; then
  echo "CERT_REUSED"
else
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout "$CERTDIR/key.pem" -out "$CERTDIR/cert.pem" -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" > "$CERTDIR/openssl.log" 2>&1
  echo "CERT_CREATED"
fi
cd "$ROOT"
TLS_PROXY_CERT="$CERTDIR/cert.pem" TLS_PROXY_KEY="$CERTDIR/key.pem" setsid nohup $BUN run scripts/dev-tls-proxy.ts > /tmp/tls-proxy.log 2>&1 &
sleep 3
tail -3 /tmp/tls-proxy.log
echo "=== health over https"
curl -sS --cacert "$CERTDIR/cert.pem" https://127.0.0.1:8443/health
echo
echo "=== p0 e2e over https"
NODE_EXTRA_CA_CERTS="$CERTDIR/cert.pem" HARNESS_BASE_URL=https://127.0.0.1:8443 HARNESS_API_KEY=live-flow-key-2026 HARNESS_BOOTSTRAP_API_KEY=live-flow-key-2026 HARNESS_SMOKE_INVITE_CODE=lab-harness-2026 $BUN run scripts/p0-e2e-smoke.ts 2>&1 | tail -5
pkill -f dev-tls-proxy.ts || true
echo
echo BATTERY_C_DONE
