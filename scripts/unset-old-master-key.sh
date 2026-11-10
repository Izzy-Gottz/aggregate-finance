#!/bin/sh
# Last step of a master-key rotation: removes AGFN_OLD_MASTER_KEYS from a Fly app, but only once it's safe.
# Usage: AGFN_OPERATOR=<you> sh scripts/unset-old-master-key.sh <fly app> <saved old key file>
# It refuses unless:
#   1. the saved file is mode 600 and holds every old key the app has loaded (compared by key id; no key is printed).
#      Older backups and database snapshots still need those keys to restore, and Fly can't give back an unset secret
#      (the 2026-11-04 staging rehearsal lost its old key this way).
#   2. a reseal dry run on the app shows no row left on an old key.
# The file may hold several keys, comma-separated, like AGFN_OLD_MASTER_KEYS itself.
set -eu
FLY=${FLYCTL:-flyctl}
command -v "$FLY" >/dev/null 2>&1 || FLY="$HOME/.fly/bin/flyctl"
APP=${1:?usage: AGFN_OPERATOR=<you> sh scripts/unset-old-master-key.sh <fly app> <saved old key file>}
SAVED=${2:?usage: AGFN_OPERATOR=<you> sh scripts/unset-old-master-key.sh <fly app> <saved old key file>}
: "${AGFN_OPERATOR:?set AGFN_OPERATOR to your name for the access record}"
[ -f "$SAVED" ] || { echo "no file at $SAVED"; exit 1; }

# Key ids match keyIdFor() in packages/security/src/envelope.ts: sha256 of the 32 key bytes, base64url, first 8.
IDS_JS='const c=require("crypto");const t=require("fs").readFileSync(0,"utf8");const ids=t.split(",").map(s=>s.trim()).filter(Boolean).map(k=>{const b=/^[0-9a-fA-F]{64}$/.test(k)?Buffer.from(k,"hex"):Buffer.from(k,"base64");if(b.length!==32){console.error("not a 32-byte key");process.exit(2)}return c.createHash("sha256").update(b).digest("base64url").slice(0,8)});console.log(ids.join(" "))'

MODE=$(node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$SAVED")
[ "$MODE" = 600 ] || { echo "refusing: $SAVED is mode $MODE; chmod 600 it first"; exit 1; }
SAVED_IDS=$(node -e "$IDS_JS" < "$SAVED")
[ -n "$SAVED_IDS" ] || { echo "refusing: no key in $SAVED"; exit 1; }

# The app's old key ids, worked out on the machine so the keys never leave it. The script goes over base64 to dodge
# nested shell quoting.
JS64=$(printf '%s' "$IDS_JS" | base64 | tr -d '\n')
HAS_OLD=$("$FLY" ssh console -a "$APP" -C "sh -c 'test -n \"\$AGFN_OLD_MASTER_KEYS\" && echo yes || echo no'" 2>/dev/null | tr -d '\r' | tail -1)
[ "$HAS_OLD" = yes ] || { [ "$HAS_OLD" = no ] && { echo "$APP has no AGFN_OLD_MASTER_KEYS loaded; nothing to unset"; exit 0; }; echo "refusing: couldn't check $APP (got: $HAS_OLD)"; exit 1; }
LOADED_IDS=$("$FLY" ssh console -a "$APP" -C "sh -c 'echo $JS64 | base64 -d > /tmp/agfn-key-ids.js && printenv AGFN_OLD_MASTER_KEYS | node /tmp/agfn-key-ids.js; rm -f /tmp/agfn-key-ids.js'" 2>/dev/null | tr -d '\r' | tail -1)
case "$LOADED_IDS" in ''|*[!A-Za-z0-9_\ -]*) echo "refusing: couldn't read the old key ids on $APP"; exit 1 ;; esac
for id in $LOADED_IDS; do
  case " $SAVED_IDS " in *" $id "*) ;; *) echo "refusing: old key $id is loaded on $APP but not in $SAVED"; exit 1 ;; esac
done
echo "saved file holds every old key ($LOADED_IDS)"

DRY=$("$FLY" ssh console -a "$APP" -C "sh -c 'cd /app && AGFN_OPERATOR=$AGFN_OPERATOR node packages/cli/src/main.ts keys reseal --reason pre-unset-check'" 2>/dev/null | tr -d '\r')
CURRENT=$(printf '%s\n' "$DRY" | sed -n 's/^current key //p' | tail -1)
[ -n "$CURRENT" ] || { echo "refusing: couldn't read the reseal dry run"; printf '%s\n' "$DRY" | tail -5; exit 1; }
LEFT=$(printf '%s\n' "$DRY" | sed -n 's/^  \([A-Za-z0-9_-]\{8\}\): \([0-9][0-9]*\) row.*/\1 \2/p' | awk -v cur="$CURRENT" '$1 != cur && $2 > 0')
[ -z "$LEFT" ] || { echo "refusing: rows still on an old key; run keys reseal --apply first:"; printf '%s\n' "$LEFT"; exit 1; }
echo "every sealed row is on the current key $CURRENT"

"$FLY" secrets unset AGFN_OLD_MASTER_KEYS -a "$APP"
echo "unset AGFN_OLD_MASTER_KEYS on $APP. Restart done by Fly; now sync one connection to check."
