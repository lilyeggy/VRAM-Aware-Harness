set -u
ROOT=/home/cxr/agent-harness-mt
BUN=/home/cxr/.bun/bin/bun
cd "$ROOT"
echo "=== STAGE 1 base phase (tool.edit N24 fix)"
PHASES="base" bash scripts/run-full-coverage-phases.sh > /data/harness/fullcoverage-test/phases3.log 2>&1
echo "BASE_EXIT=$?"
tail -6 /data/harness/fullcoverage-test/phases3.log
python3 -c "
import json
d=json.load(open('/data/harness/fullcoverage-test/report-base.json'))
items=d if isinstance(d,list) else d.get('results',[])
from collections import Counter
print('COUNTS', dict(Counter(i.get('status') for i in items)))
for i in items:
    if i.get('status')=='FAIL':
        print('  FAIL', i.get('id'), '::', str(i.get('detail'))[:200])
"
echo "=== STAGE 2 worker crash F1/F2"
HARNESS_BASE_URL=http://127.0.0.1:3100 HARNESS_SMOKE_INVITE_CODE=lab-harness-2026 HARNESS_PHASE5_SUDO_PASSWORD=123456 HARNESS_PHASE5_LABEL=batteryD $BUN run scripts/phase5-worker-crash.ts 2>&1 | tail -25
echo "=WORKER_CRASH_EXIT=$?"
echo "=== STAGE 3 restore services"
echo 123456 | sudo -S -p "" systemctl start harness-broker.service
sleep 2
echo 123456 | sudo -S -p "" systemctl is-active harness-broker.service harness.service
curl -sS --max-time 5 http://127.0.0.1:3100/health
echo
systemctl list-units --type=service --state=running --no-legend "harness-worker-*" | head -3
echo BATTERY_D_DONE
