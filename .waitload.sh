#!/bin/sh
# Wait until the one-minute load average drops under 14, then run probe:smoke.
# PROJECT.md section 8: above load ~8 probes do not fail, they time out, and a
# timeout reads like a failure. A number taken at load 268 is worthless.
while true; do
  L=$(uptime | sed 's/.*averages: //' | awk '{print int($1)}')
  if [ "$L" -lt 14 ]; then break; fi
  sleep 45
done
echo "load settled at: $(uptime)"
npm run probe:smoke 2>&1 | tail -50
echo "final load: $(uptime)"
