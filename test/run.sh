#!/bin/bash
# Self-contained API test: seeds a fresh local KV from seed/milestones.json, starts `wrangler pages dev`
# on $PORT with a throwaway PIN ($PIN), asserts every case, exits non-zero on any failure.
# Usage: PORT=8791 PIN=123456 ./test/run.sh      (PIN is random if unset; never use the real PIN)
cd "$(dirname "$0")/.." || exit 2
ROOT=$PWD
PORT=${PORT:-8791}
PIN=${PIN:-$(shuf -i 100000-999999 -n1)}
W=${WRANGLER:-/workspace/wrangler-tools/node_modules/.bin/wrangler}
HASH=$(printf '%s' "$PIN" | sha256sum | cut -d' ' -f1)
STATE=$(mktemp -d); LOG=$STATE/server.log
B=http://localhost:$PORT
FAILS=0; PASSES=0
export MAX_PHOTOS_TOTAL_TEST=30

kvget(){ $W kv key get --namespace-id MILESTONES --local --persist-to "$STATE" "$1" 2>/dev/null; }
kvdel(){ $W kv key delete --namespace-id MILESTONES --local --persist-to "$STATE" "$1" >/dev/null 2>&1; }
reset(){ kvdel rl:global; for i in "$@"; do kvdel "rl:$i"; done; }

$W kv key put --namespace-id MILESTONES --local --persist-to "$STATE" milestones --path seed/milestones.json >/dev/null 2>&1 || { echo "seed failed"; exit 2; }
$W pages dev public --kv MILESTONES --port "$PORT" --persist-to "$STATE" \
  -b TRACKER_PIN_HASH="$HASH" -b MAX_PHOTOS_TOTAL=$MAX_PHOTOS_TOTAL_TEST >"$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; pkill -P $SRV 2>/dev/null; rm -rf "$STATE"' EXIT
for i in $(seq 1 60); do curl -s -o /dev/null $B/api/health && break; sleep 1; done
curl -s -o /dev/null $B/api/health || { echo "server did not start"; cat "$LOG"; exit 2; }

# check NAME EXPECTED_CODE [BODY_REGEX] -- curl args...   (body in /tmp/tt_body)
check(){
  local name=$1 want=$2 re=$3; shift 3; [ "$1" = "--" ] && shift
  local got; got=$(curl -s -m 20 -o /tmp/tt_body -w '%{http_code}' "$@")
  if [ "$got" = "$want" ] && { [ -z "$re" ] || grep -Eq -- "$re" /tmp/tt_body; }; then
    PASSES=$((PASSES+1)); echo "PASS $name ($got)"
  else FAILS=$((FAILS+1)); echo "FAIL $name: want $want${re:+ /$re/} got $got: $(head -c 200 /tmp/tt_body)"; fi
}
assert(){ # assert NAME CONDITION(0=true)
  if [ "$2" = 0 ]; then PASSES=$((PASSES+1)); echo "PASS $1"; else FAILS=$((FAILS+1)); echo "FAIL $1"; fi
}
put(){ # put NAME CODE REGEX IP PIN DATA [extra curl args]
  local name=$1 code=$2 re=$3 ip=$4 pin=$5 data=$6; shift 6
  check "$name" "$code" "$re" -- -X PUT $B/api/milestones -H "CF-Connecting-IP: $ip" ${pin:+-H "X-Edit-Pin: $pin"} -H 'content-type: application/json' -d "$data" "$@"
}
# build records JSON with ids from a list
mk(){ python3 - "$@" <<'PY'
import sys,json
print(json.dumps({"records":{i:{"done":False,"date":"2026-10-01","note":"n"+i} for i in sys.argv[1:]}}))
PY
}
ALL="1 1.1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17"
FULL=$(mk $ALL); R15=$(mk 1 1.1 2 3 4 5 6 7 8 9 10 11 12 13 14); R12=$(mk 1 1.1 2 3 4 5 6 7 8 9 10 11)

echo "== public dir clean"; ./test/public-clean.sh >/dev/null; assert "public/ has no data/secret files" $?
echo "== seeded baseline"
check "GET open" 200 '"records"' -- $B/api/milestones
assert "seed has 6 records" $(python3 -c "import json;print(0 if len(json.load(open('/tmp/tt_body'))['records'])==6 else 1)")
reset 1.1.1.1 2.2.2.2 3.3.3.3 4.4.4.4 5.5.5.5 7.7.7.7
echo "== PIN gating"
put "no PIN -> 401" 401 pin_required 1.1.1.1 "" "$FULL"
put "wrong PIN -> 401" 401 wrong_pin 1.1.1.1 000000 "$FULL"
put "right PIN saves 18" 200 '"1.1"' 1.1.1.1 $PIN "$FULL"
echo "== validation"
put "{} rejected" 400 invalid_records 1.1.1.1 $PIN '{}'
put "constructor rejected" 400 invalid_records 1.1.1.1 $PIN '{"records":{"constructor":{"done":true}}}'
put "__proto__ rejected" 400 invalid_records 1.1.1.1 $PIN '{"records":{"__proto__":{"done":true}}}'
put "unknown id rejected" 400 invalid_records 1.1.1.1 $PIN '{"records":{"99":{"done":true}}}'
put "long note rejected" 400 invalid_records 1.1.1.1 $PIN "{\"records\":{\"1\":{\"note\":\"$(printf 'x%.0s' $(seq 301))\"}}}"
put "date 2026-13-99 rejected" 400 invalid_records 1.1.1.1 $PIN '{"records":{"1":{"date":"2026-13-99"}}}'
put "date 2026-02-30 rejected" 400 invalid_records 1.1.1.1 $PIN '{"records":{"1":{"date":"2026-02-30"}}}'
put "date 06/09/2026 rejected" 400 invalid_records 1.1.1.1 $PIN '{"records":{"1":{"date":"06/09/2026"}}}'
put "array rejected" 400 invalid_records 1.1.1.1 $PIN '[1,2]'
put "malformed JSON, right PIN -> 400" 400 invalid_json 1.1.1.1 $PIN '{bad'
put "malformed JSON, wrong PIN -> 401 (PIN before body)" 401 wrong_pin 1.1.1.1 999999 '{bad'
reset 1.1.1.1
put "valid leap date 2028-02-29 accepted" 200 '' 1.1.1.1 $PIN "$(mk 1 1.1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 | sed 's/2026-10-01/2028-02-29/')"
echo "== erosion guard + backups"
put "write 18->15 ok" 200 '' 1.1.1.1 $PIN "$R15"
put "write 15->12 refused (<15)" 409 too_few_records 1.1.1.1 $PIN "$R12"
check "still 15 records" 200 '' -- $B/api/milestones
assert "records stay 15" $(python3 -c "import json;print(0 if len(json.load(open('/tmp/tt_body'))['records'])==15 else 1)")
put "write 15->12 with X-Force-Write" 200 '' 1.1.1.1 $PIN "$R12" -H 'X-Force-Write: 1'
put "force without PIN still 401" 401 pin_required 1.1.1.1 "" "$R12" -H 'X-Force-Write: 1'
put "restore 18 (adds only)" 200 '' 1.1.1.1 $PIN "$FULL"
for k in 1 2 3; do assert "backup milestones:prev$k exists" $([ -n "$(kvget milestones:prev$k)" ] && echo 0 || echo 1); done
assert "no legacy milestones:prev needed (prev1 is newest backup)" $(kvget milestones:prev1 | grep -q '"1"' && echo 0 || echo 1)
echo "== body limits"
head -c 300000 /dev/zero | tr '\0' 'a' > /tmp/tt_big.json
check "300KB body -> 413" 413 payload_too_large -- -X PUT $B/api/milestones -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN" --data-binary @/tmp/tt_big.json
check "300KB chunked -> 413" 413 payload_too_large -- -X PUT $B/api/milestones -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN" -H 'Transfer-Encoding: chunked' --data-binary @/tmp/tt_big.json
check "small chunked valid body -> 200" 200 '' -- -X PUT $B/api/milestones -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN" -H 'Transfer-Encoding: chunked' -H 'content-type: application/json' -d "$FULL"
rawput(){ # rawput CLAIMED_LEN BODYFILE -> status line code
  python3 - "$PORT" "$PIN" "$1" "$2" <<'PY'
import socket,sys
port,pin,cl,f=int(sys.argv[1]),sys.argv[2],sys.argv[3],sys.argv[4]
body=open(f,'rb').read()
s=socket.create_connection(('localhost',port),timeout=15)
s.sendall(("PUT /api/milestones HTTP/1.1\r\nHost: x\r\nCF-Connecting-IP: 1.1.1.1\r\nX-Edit-Pin: %s\r\nContent-Length: %s\r\nConnection: close\r\n\r\n"%(pin,cl)).encode()+body)
d=b''
try:
  while True:
    c=s.recv(65536)
    if not c:break
    d+=c
except Exception: pass
print(d.split(b' ')[1].decode() if d else 'none')
PY
}
echo -n '{"records":{"1":{"done":true}}}' > /tmp/tt_small.json
assert "lying Content-Length 10 (300KB body sent) -> never 200" $([ "$(rawput 10 /tmp/tt_big.json)" != 200 ] && echo 0 || echo 1)
# NOTE: a Content-Length larger than the bytes actually sent stalls inside local miniflare before reaching the function, so it cannot be exercised locally; the code path (readLimited CL check) is the same one the 300KB test hits.
echo "== 405 JSON"
check "PATCH milestones -> 405 JSON" 405 method_not_allowed -- -X PATCH $B/api/milestones
check "DELETE milestones -> 405 JSON" 405 method_not_allowed -- -X DELETE $B/api/milestones
check "GET check-pin -> 405 JSON" 405 method_not_allowed -- $B/api/check-pin
echo "== rate limits"
reset 1.1.1.1 2.2.2.2
for i in 1 2 3 4 5 6 7 8; do put x 401 '' 2.2.2.2 "" "$FULL" >/dev/null; done
put "8 no-PIN requests are not strikes; right PIN works" 200 '' 2.2.2.2 $PIN "$FULL"
reset 3.3.3.3; for i in 1 2 3 4; do put x 401 '' 3.3.3.3 000000 "$FULL" >/dev/null; done
put "correct PIN after 4 strikes ok (resets)" 200 '' 3.3.3.3 $PIN "$FULL"
assert "counter cleared" $(kvget rl:3.3.3.3 | grep -Eq "^[0-9]+$" && echo 1 || echo 0)
reset 4.4.4.4; for i in 1 2 3 4 5; do curl -s -o /dev/null -X PUT $B/api/milestones -H "CF-Connecting-IP: 4.4.4.4" -H "X-Forwarded-For: 9.9.9.$i" -H "X-Edit-Pin: 00000$i" -d "$FULL"; done
put "spoofed X-Forwarded-For does not bypass lockout -> 429" 429 too_many_attempts 4.4.4.4 $PIN "$FULL" -H 'X-Forwarded-For: 8.8.8.8'
put "other IP unaffected" 200 '' 5.5.5.5 $PIN "$FULL"
reset 4.4.4.4 5.5.5.5; for i in $(seq 1 20); do curl -s -o /dev/null -X PUT $B/api/milestones -H "CF-Connecting-IP: 10.0.0.$i" -H "X-Edit-Pin: 111111" -d "$FULL"; done
put "global cap: 21st new IP -> 429" 429 too_many_attempts 10.0.1.1 111111 "$FULL"
put "global cap: right PIN from new IP also 429" 429 too_many_attempts 10.0.1.2 $PIN "$FULL"
reset
check "check-pin right" 200 '"ok"' -- -X POST $B/api/check-pin -H "CF-Connecting-IP: 7.7.7.7" -H "X-Edit-Pin: $PIN"
check "check-pin wrong" 401 wrong_pin -- -X POST $B/api/check-pin -H "CF-Connecting-IP: 7.7.7.7" -H "X-Edit-Pin: 222222"
check "check-pin missing" 401 pin_required -- -X POST $B/api/check-pin -H "CF-Connecting-IP: 7.7.7.7"
check "GET still open" 200 '"records"' -- $B/api/milestones
reset 7.7.7.7
grep -q "ALERT: no CF-Connecting-IP" functions/_lib/guard.js; assert "local-bucket console.warn present in guard (wrangler dev always injects CF-Connecting-IP, so only statically checkable)" $?
reset local

echo "== photos API"
reset; PH=/tmp/ph
post(){ # post NAME CODE REGEX IP PIN QUERY FILE [curl extras]
  local name=$1 code=$2 re=$3 ip=$4 pin=$5 q=$6 f=$7; shift 7
  check "$name" "$code" "$re" -- -X POST "$B/api/photos?$q" -H "CF-Connecting-IP: $ip" ${pin:+-H "X-Edit-Pin: $pin"} --data-binary @"$f" "$@"
}
pid(){ python3 -c "import json;print(json.load(open('/tmp/tt_body'))['id'])"; }
post "upload no PIN -> 401" 401 pin_required 1.1.1.1 "" "milestone=2" $PH/ok.jpg
post "upload wrong PIN -> 401" 401 wrong_pin 1.1.1.1 000000 "milestone=2" $PH/ok.jpg
reset 1.1.1.1
post "fake text file named .jpg -> 415" 415 not_a_supported_image 1.1.1.1 $PIN "milestone=2" $PH/fake.jpg -H 'Content-Type: image/jpeg'
post ">2MB photo -> 413" 413 photo_too_large 1.1.1.1 $PIN "milestone=2" $PH/big.jpg
post ">2MB chunked photo -> 413" 413 photo_too_large 1.1.1.1 $PIN "milestone=2" $PH/big.jpg -H 'Transfer-Encoding: chunked'
post "unknown milestone -> 400" 400 unknown_milestone 1.1.1.1 $PIN "milestone=99" $PH/ok.jpg
post "bad date 2026-13-99 -> 400" 400 invalid_date 1.1.1.1 $PIN "milestone=2&date=2026-13-99" $PH/ok.jpg
post "caption 201 chars -> 400" 400 caption_too_long 1.1.1.1 $PIN "milestone=2&caption=$(printf 'a%.0s' $(seq 201))" $PH/ok.jpg
CAP=$(python3 -c "import urllib.parse;print(urllib.parse.quote('เตรียมพื้นที่ / Soil <b>clearing</b>'))")
post "valid JPEG (ms 2, Thai caption) -> 201" 201 '"id"' 1.1.1.1 $PIN "milestone=2&date=2026-10-11&caption=$CAP" $PH/ok.jpg -H 'Content-Type: text/html'
ID1=$(pid)
curl -s -D /tmp/tt_hdr -o /tmp/tt_img "$B/api/photos/$ID1"
assert "GET photo: 200 + exact bytes" $(grep -q ' 200' /tmp/tt_hdr && cmp -s /tmp/tt_img $PH/ok.jpg && echo 0 || echo 1)
assert "GET photo: Content-Type from validated type (image/jpeg) even though client said text/html" $(grep -qi '^content-type: image/jpeg' /tmp/tt_hdr && echo 0 || echo 1)
assert "GET photo: nosniff + long immutable cache" $(grep -qi '^x-content-type-options: nosniff' /tmp/tt_hdr && grep -qi 'max-age=31536000' /tmp/tt_hdr && echo 0 || echo 1)
post "PNG accepted" 201 '"id"' 1.1.1.1 $PIN "milestone=2" $PH/ok.png -H 'Content-Type: image/jpeg'; ID2=$(pid)
curl -s -D /tmp/tt_hdr -o /dev/null "$B/api/photos/$ID2"; assert "PNG served as image/png (client label ignored)" $(grep -qi '^content-type: image/png' /tmp/tt_hdr && echo 0 || echo 1)
post "WebP accepted" 201 '"id"' 1.1.1.1 $PIN "milestone=3" $PH/ok.webp; ID3=$(pid)
post "photo with NO milestone (general) -> 201" 201 '"milestoneId":""' 1.1.1.1 $PIN "date=2026-10-10&caption=general" $PH/ok.jpg; ID4=$(pid)
post "date defaults to today when omitted" 201 '"date":"20' 1.1.1.1 $PIN "milestone=3" $PH/ok.jpg; ID5=$(pid)
check "GET invalid id -> 400" 400 invalid_id -- "$B/api/photos/not-a-uuid"
check "GET unknown valid uuid -> 404" 404 not_found -- "$B/api/photos/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"
check "list ms 2 (open)" 200 "$ID1" -- "$B/api/photos?milestone=2"
assert "list ms 2: Thai caption kept as text, newest first (2 entries)" $(python3 -c "
import json;p=json.load(open('/tmp/tt_body'))['photos'];print(0 if len(p)==2 and any('เตรียมพื้นที่' in x['caption'] for x in p) and p[0]['createdAt']>=p[1]['createdAt'] and all(x['milestoneId']=='2' for x in p) else 1)")
check "list all includes general photo with empty milestoneId" 200 "$ID4" -- "$B/api/photos"
check "list unknown milestone -> 400" 400 unknown_milestone -- "$B/api/photos?milestone=zzz"
check "PATCH photos -> 405 JSON" 405 method_not_allowed -- -X PATCH $B/api/photos
echo "-- delete"
check "DELETE no PIN -> 401" 401 pin_required -- -X DELETE "$B/api/photos/$ID1" -H "CF-Connecting-IP: 1.1.1.1"
check "DELETE wrong PIN -> 401" 401 wrong_pin -- -X DELETE "$B/api/photos/$ID1" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: 000000"
reset 1.1.1.1
check "photo still there after refused deletes" 200 '' -- "$B/api/photos/$ID1"
check "DELETE right PIN -> 200" 200 '"ok"' -- -X DELETE "$B/api/photos/$ID1" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN"
check "deleted photo -> 404" 404 not_found -- "$B/api/photos/$ID1"
check "deleted photo gone from list" 200 '' -- "$B/api/photos?milestone=2"
assert "index no longer lists it" $(grep -q "$ID1" /tmp/tt_body && echo 1 || echo 0)
check "DELETE again -> 404" 404 not_found -- -X DELETE "$B/api/photos/$ID1" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN"
for i in $ID2 $ID3 $ID4 $ID5; do curl -s -o /dev/null -X DELETE "$B/api/photos/$i" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN"; done
echo "-- caps (total cap lowered to $MAX_PHOTOS_TOTAL_TEST via MAX_PHOTOS_TOTAL for the test)"
for i in $(seq 1 12); do curl -s -o /dev/null -X POST "$B/api/photos?milestone=2" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN" --data-binary @$PH/ok.jpg; done
post "13th photo on one milestone -> 409" 409 milestone_photo_limit 1.1.1.1 $PIN "milestone=2" $PH/ok.jpg
for i in $(seq 1 12); do curl -s -o /dev/null -X POST "$B/api/photos?milestone=3" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN" --data-binary @$PH/ok.jpg; done
for i in $(seq 1 6); do curl -s -o /dev/null -X POST "$B/api/photos?milestone=4" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN" --data-binary @$PH/ok.jpg; done
post "31st photo overall -> 409 total cap" 409 total_photo_limit 1.1.1.1 $PIN "milestone=5" $PH/ok.jpg
post "general photo over total cap -> 409" 409 total_photo_limit 1.1.1.1 $PIN "" $PH/ok.jpg
curl -s "$B/api/photos" | python3 -c "import json,sys;print('\n'.join(p['id'] for p in json.load(sys.stdin)['photos']))" > /tmp/tt_ids
assert "30 photos listed" $([ "$(wc -l < /tmp/tt_ids)" = 30 ] && echo 0 || echo 1)
while read i; do curl -s -o /dev/null -X DELETE "$B/api/photos/$i" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN"; done < /tmp/tt_ids
check "all cleaned" 200 '"photos":\[\]' -- "$B/api/photos"
echo "-- lockout still holds on photo endpoints"
reset 6.6.6.6
for i in 1 2 3 4 5; do curl -s -o /dev/null -X POST "$B/api/photos?milestone=2" -H "CF-Connecting-IP: 6.6.6.6" -H "X-Edit-Pin: 00000$i" --data-binary @$PH/ok.jpg; done
post "6th try, RIGHT PIN, same IP -> 429" 429 too_many_attempts 6.6.6.6 $PIN "milestone=2" $PH/ok.jpg
check "DELETE also locked -> 429" 429 too_many_attempts -- -X DELETE "$B/api/photos/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b" -H "CF-Connecting-IP: 6.6.6.6" -H "X-Edit-Pin: $PIN"
reset 6.6.6.6
assert "public/ still clean" $(./test/public-clean.sh >/dev/null && echo 0 || echo 1)

echo "== UI (Playwright, chromium)"
PW_DIR=${PW_DIR:-/workspace/pw-test}
if [ -d "$PW_DIR/node_modules/playwright" ]; then
  python3 test/make-photo.py /tmp/ph/big4000x3000.jpg
  reset
  BASE=$B PIN=$PIN PW_DIR=$PW_DIR SEED_DIR=${SEED_DIR:-/workspace/construction-photos/2026-10-11} node test/ui.cjs
  assert "Playwright UI suite" $?
else echo "FAIL: playwright not found in PW_DIR=$PW_DIR (npm i playwright && npx playwright install chromium)"; FAILS=$((FAILS+1)); fi
echo "== /progress/ timeline (public, privacy)"
reset; SEED_DIR=${SEED_DIR:-/workspace/construction-photos/2026-10-11}
check "progress API empty state" 200 '^\{"photos":\[\]\}$' -- $B/api/progress
check "progress page served" 200 'noindex' -- $B/progress/
MODE=empty BASE=$B PW_DIR=$PW_DIR node test/ui-progress.cjs; assert "timeline UI empty state (both viewports)" $?
CAPTH="เตรียมพื้นที่และปรับระดับดินด้วยรถแบ็คโฮ / Soil clearing and levelling with excavator"
CAPQ=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$CAPTH")
SEEDS=(); if [ -d "$SEED_DIR" ]; then for f in "$SEED_DIR"/*.jp*g; do SEEDS+=("$f"); done; fi
while [ ${#SEEDS[@]} -lt 6 ]; do SEEDS+=(/tmp/ph/ok.jpg); done
n=0; for f in "${SEEDS[@]:0:6}"; do n=$((n+1)); check "seed real photo $n via upload API (2026-10-11, no milestone)" 201 '"id"' -- -X POST "$B/api/photos?date=2026-10-11&caption=$CAPQ" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN" --data-binary @"$f"; done
for k in 1 2; do check "seed 2026-10-10 photo $k (milestone 2)" 201 '' -- -X POST "$B/api/photos?milestone=2&date=2026-10-10&caption=Pile%20prep%20$k" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN" --data-binary @/tmp/ph/ok.jpg; done
check "seed 2026-10-05 photo (general)" 201 '' -- -X POST "$B/api/photos?date=2026-10-05&caption=Site%20visit" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN" --data-binary @/tmp/ph/ok.jpg
for k in $(seq 1 18); do curl -s -o /dev/null -X POST "$B/api/photos?date=2026-09-$(printf %02d $((k+1)))&caption=Older%20$k" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN" --data-binary @/tmp/ph/ok.jpg; done
check "progress API page 1 (24)" 200 '"photos"' -- "$B/api/progress"
cp /tmp/tt_body /tmp/tt_prog1
assert "progress: only key 'photos'; each photo only {id,date,caption,milestoneTitle}; 24 rows; newest first" $(python3 - <<'PY'
import json
d=json.load(open('/tmp/tt_prog1'))
p=d['photos']; dates=[x['date'] for x in p]
ok = list(d.keys())==['photos'] and len(p)==24 and all(sorted(x.keys())==['caption','date','id','milestoneTitle'] for x in p) and dates==sorted(dates,reverse=True)
print(0 if ok else 1)
PY
)
assert "progress: general photos have milestoneTitle null, milestone photos a title" $(python3 - <<'PY'
import json
p=json.load(open('/tmp/tt_prog1'))['photos']
g=[x for x in p if x['date']=='2026-10-11']; m=[x for x in p if x['date']=='2026-10-10']
print(0 if len(g)==6 and all(x['milestoneTitle'] is None for x in g) and len(m)==2 and all(isinstance(x['milestoneTitle'],str) and x['milestoneTitle'] for x in m) else 1)
PY
)
check "progress offset=24 -> remaining 3" 200 '"photos"' -- "$B/api/progress?offset=24&limit=24"
assert "progress page 2 has 3" $(python3 -c "import json;print(0 if len(json.load(open('/tmp/tt_body'))['photos'])==3 else 1)")
check "progress limit capped at 50" 200 '"photos"' -- "$B/api/progress?limit=9999"
assert "limit cap <=50 rows" $(python3 -c "import json;print(0 if len(json.load(open('/tmp/tt_body'))['photos'])<=50 else 1)")
check "progress needs no PIN, POST -> 405 JSON" 405 method_not_allowed -- -X POST $B/api/progress
PRIV='note|done|ชำระ|จ่าย|บาท|paid|amount|[0-9]{3},[0-9]{3}'
curl -s "$B/api/progress?limit=50" > /tmp/tt_prog_all; assert "API response has no note/done/payment text" $(grep -Eiq "$PRIV" /tmp/tt_prog_all && echo 1 || echo 0)
curl -s "$B/progress/" > /tmp/tt_prog_page; assert "/progress/ HTML has no note/done/payment text" $(grep -Eiq "$PRIV" /tmp/tt_prog_page && echo 1 || echo 0)
assert "/progress/ has no links (nothing links back to tracker)" $(grep -q 'href=' /tmp/tt_prog_page && echo 1 || echo 0)
assert "tracker page links to /progress/" $(curl -s $B/ | grep -q 'href="/progress/"' && echo 0 || echo 1)
assert "progress.js never reads milestone records" $(grep -Eq "get\(['\"]milestones|api/milestones" functions/api/progress.js && echo 1 || echo 0)
assert "public/ only holds index.html, progress/index.html, _headers" $(./test/public-clean.sh >/dev/null && echo 0 || echo 1)
MODE=full BASE=$B PW_DIR=$PW_DIR node test/ui-progress.cjs; assert "timeline UI full suite (390x844 and 1280x800)" $?
curl -s "$B/api/photos" | python3 -c "import json,sys;print('\n'.join(p['id'] for p in json.load(sys.stdin)['photos']))" > /tmp/tt_ids
while read i; do curl -s -o /dev/null -X DELETE "$B/api/photos/$i" -H "CF-Connecting-IP: 1.1.1.1" -H "X-Edit-Pin: $PIN"; done < /tmp/tt_ids


echo; echo "RESULT: $PASSES passed, $FAILS failed"
[ "$FAILS" = 0 ]
