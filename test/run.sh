#!/bin/bash
# Usage: PIN=<throwaway pin> ./test/run.sh   (server: wrangler pages dev public --kv MILESTONES --port 8788)
B=http://localhost:8788; W=wrangler
kvget(){ $W kv key get --namespace-id MILESTONES --local "$1" 2>/dev/null; }
kvdel(){ $W kv key delete --namespace-id MILESTONES --local "$1" >/dev/null 2>&1; }
reset(){ kvdel rl:global; for i in "$@"; do kvdel "rl:$i"; done; }
code(){ curl -s -o /tmp/body -w '%{http_code}' "$@"; echo " $(head -c 150 /tmp/body)"; }
put(){ ip=$1; pin=$2; data=$3; code -X PUT $B/api/milestones -H "CF-Connecting-IP: $ip" ${pin:+-H "X-Edit-Pin: $pin"} -H 'content-type: application/json' -d "$data"; }
GOOD='{"records":{"1":{"done":true,"date":"2026-09-06","note":"a"},"1.1":{"done":true,"date":"2026-10-06","note":"b"}}}'
echo "== 0 public listing"; ./test/public-clean.sh
echo "== 1 baseline GET (open)"; code $B/api/milestones
reset 1.1.1.1 local
echo "== right PIN saves"; put 1.1.1.1 $PIN "$GOOD"
echo "== PUT {} with right PIN -> 400, data intact"; put 1.1.1.1 $PIN '{}'; put 1.1.1.1 $PIN '{"records":{}}'; code $B/api/milestones
echo "== constructor / __proto__ / unknown id / long note / bad date / array"
put 1.1.1.1 $PIN '{"records":{"constructor":{"done":true}}}'
put 1.1.1.1 $PIN '{"records":{"__proto__":{"done":true}}}'
put 1.1.1.1 $PIN '{"records":{"99":{"done":true}}}'
put 1.1.1.1 $PIN "{\"records\":{\"1\":{\"note\":\"$(printf 'x%.0s' $(seq 301))\"}}}"
put 1.1.1.1 $PIN '{"records":{"1":{"date":"06/09/2026"}}}'
put 1.1.1.1 $PIN '[1,2]'
echo "== removing >3 records -> 409 (seed 4 records via full write first)"
FULL='{"records":{"1":{"done":true},"1.1":{"done":true},"2":{"done":false},"3":{"done":false},"4":{"done":false},"5":{"done":false}}}'
put 1.1.1.1 $PIN "$FULL"
put 1.1.1.1 $PIN '{"records":{"1":{"done":true}}}'
put 1.1.1.1 $PIN '{"records":{"1":{"done":true},"1.1":{"done":true},"2":{"done":false}}}'
echo "== milestones:prev exists (local KV)"; kvget milestones:prev | head -c 200; echo
echo "== malformed JSON: right PIN -> 400 JSON; wrong PIN -> 401 (PIN before body)"
put 1.1.1.1 $PIN '{bad'; put 1.1.1.1 999999 '{bad'
reset 1.1.1.1
echo "== 256kb limit"; head -c 300000 /dev/zero | tr '\0' 'a' > /tmp/big.json; code -X PUT $B/api/milestones -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN" --data-binary @/tmp/big.json
echo "== no PIN -> 401 and NOT a strike (8 tries then right PIN still works)"
reset 2.2.2.2; for i in 1 2 3 4 5 6 7 8; do put 2.2.2.2 "" "$GOOD" >/dev/null; done; put 2.2.2.2 "" "$GOOD"; put 2.2.2.2 $PIN "$GOOD"
echo "== wrong PINs: 4 strikes, correct PIN resets, 4 more strikes still not locked"
reset 3.3.3.3; for i in 1 2 3 4; do put 3.3.3.3 000000 "$GOOD" >/dev/null; done; echo "counter: $(kvget rl:3.3.3.3)"
put 3.3.3.3 $PIN "$GOOD"; echo "counter after correct: [$(kvget rl:3.3.3.3)]"
for i in 1 2 3 4; do put 3.3.3.3 000000 "$GOOD" >/dev/null; done; put 3.3.3.3 $PIN "$GOOD"
echo "== spoofed X-Forwarded-For does not bypass lockout (same CF IP 4.4.4.4)"
reset 4.4.4.4; for i in 1 2 3 4 5 6 7 8; do echo -n "try$i: "; curl -s -o /tmp/body -w '%{http_code}\n' -X PUT $B/api/milestones -H "CF-Connecting-IP: 4.4.4.4" -H "X-Forwarded-For: 9.9.9.$i" -H "X-Edit-Pin: 00000$i" -d "$GOOD"; done
echo "== locked IP even with right PIN"; put 4.4.4.4 $PIN "$GOOD"
echo "== other IP unaffected"; put 5.5.5.5 $PIN "$GOOD"
echo "== global cap: 20 wrong PINs from distinct IPs, then 429 for new IP"
reset 4.4.4.4 5.5.5.5 6.6.6.1; for i in $(seq 1 20); do echo -n "$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/api/milestones -H "CF-Connecting-IP: 10.0.0.$i" -H "X-Edit-Pin: 111111" -d "$GOOD") "; done; echo
echo "global counter: $(kvget rl:global)"; echo -n "21st new IP wrong: "; put 10.0.1.1 111111 "$GOOD"; echo -n "new IP right PIN: "; put 10.0.1.2 $PIN "$GOOD"
echo "== check-pin"; reset
echo -n "right: "; code -X POST $B/api/check-pin -H "CF-Connecting-IP: 7.7.7.7" -H "X-Edit-Pin: $PIN"
echo -n "wrong: "; code -X POST $B/api/check-pin -H "CF-Connecting-IP: 7.7.7.7" -H "X-Edit-Pin: 222222"
echo -n "missing: "; code -X POST $B/api/check-pin -H "CF-Connecting-IP: 7.7.7.7"
for i in 1 2 3 4; do code -X POST $B/api/check-pin -H "CF-Connecting-IP: 7.7.7.7" -H "X-Edit-Pin: 22222$i" >/dev/null; done
echo -n "after 5 wrong: "; code -X POST $B/api/check-pin -H "CF-Connecting-IP: 7.7.7.7" -H "X-Edit-Pin: $PIN"
echo "== GET stays open"; code $B/api/milestones
reset 7.7.7.7
