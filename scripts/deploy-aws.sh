#!/usr/bin/env bash
# Deploy Aggregate on an AWS EC2 box (Docker + Caddy, deploy/aws/Caddyfile). Runs ON the box, e.g. over SSM:
#
#   deploy-aws.sh deploy <image>   release step, start the new container beside the old, wait for /healthz, switch
#                                  Caddy to it, drain and stop the old one
#   deploy-aws.sh rollback         the same, with the image that served before the last deploy
#   deploy-aws.sh status           which container serves, and the current and previous images
#
# Order, and what each failure leaves:
#   1. pull the image                 fails: nothing changed
#   2. release step (release.ts):     migrations, auth tables, RLS policies. Fails: nothing changed, the old
#      one container, then exits      container keeps serving (migrations are additive by rule; a failed one rolls
#                                     back in its transaction)
#   3. start the new container on the idle port (blue 8787 / green 8788, 127.0.0.1 only; nothing else published:
#      the metrics port 9091 stays inside the container)
#   4. wait for its /healthz          fails: the new container is removed, the old keeps serving
#   5. write upstream.caddy, reload Caddy (graceful: in-flight requests finish on the old upstream)
#   6. drain, then stop the old container (kept, stopped, until the next deploy; its image is kept for rollback)
#
# Every deploy gets a fresh AGFN_RELEASE (image tag + UTC time): the job queue's release guard lets only the newest
# release's worker claim jobs during the overlap, and hosted boot refuses a worker without one (config.ts).
#
# Settings (env):
#   AGFN_ENV_FILE    the container's env file (0600). Or AGFN_SSM_PATH: read every SecureString under that Parameter
#                    Store path into a temporary 0600 env file, removed on exit. Values are never printed.
#   AGFN_STATE_DIR   current/previous image records (default /var/lib/agfn)
#   AGFN_CADDY_DIR   where upstream.caddy lives (default /etc/caddy)
#   AGFN_CADDY_RELOAD  command that reloads Caddy (default: caddy reload --config $AGFN_CADDY_DIR/Caddyfile)
#   AGFN_DRAIN_S     seconds the old container keeps answering after the switch (default 30)
#   AGFN_HEALTH_S    seconds to wait for the new /healthz (default 120; the ready gate waits up to 45)
#   AGFN_DOCKER_ARGS extra `docker run` arguments (e.g. --log-driver=awslogs ...), word-split
#   AGFN_NAME        container name prefix (default agfn)
#   AGFN_NO_PULL=1   use a local image as is (tests; the box always pulls)
#   AGFN_GIT_SHA     the commit the image was built from, for the deploy record (else the image's
#                    org.opencontainers.image.revision label, else "unknown")
#   AGFN_DEPLOY_BY   who runs it, for the deploy record (else SUDO_USER, else the login name)
#   AGFN_DEPLOY_LOG_GROUP  CloudWatch log group for the deploy record (90-day retention, set by the box setup); the
#                    stream is the host name. Unset: the local file only.
#
# Deploy record: every deploy and rollback, finished or failed, appends one JSON line (time, action, release, image,
# digest, git sha, result, who) to $AGFN_STATE_DIR/deploys.jsonl (0600, last 1000 lines kept) and, when
# AGFN_DEPLOY_LOG_GROUP is set, to that CloudWatch group. A failed CloudWatch write is reported, never fatal: the local
# line is already written.
set -euo pipefail

DOCKER=${DOCKER:-docker}
STATE=${AGFN_STATE_DIR:-/var/lib/agfn}
CADDY_DIR=${AGFN_CADDY_DIR:-/etc/caddy}
RELOAD=${AGFN_CADDY_RELOAD:-caddy reload --config $CADDY_DIR/Caddyfile --adapter caddyfile}
DRAIN=${AGFN_DRAIN_S:-30}
HEALTH_S=${AGFN_HEALTH_S:-120}
NAME=${AGFN_NAME:-agfn}
BLUE_PORT=8787
GREEN_PORT=8788

say() { echo "[deploy-aws] $*"; }
die() {
  echo "[deploy-aws] FAILED: $*" >&2
  [ -n "$REC_IMAGE" ] && record "failed: $*"
  exit 1
}

# ---------- deploy record ----------

ACTION=deploy
REC_IMAGE=""
REC_RELEASE=""
REC_DIGEST=""
json_str() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037')"; }
record() { # result
  local who sha line
  who=${AGFN_DEPLOY_BY:-${SUDO_USER:-$(id -un 2>/dev/null || echo unknown)}}
  sha=${AGFN_GIT_SHA:-$("$DOCKER" image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$REC_IMAGE" 2>/dev/null || true)}
  case "$sha" in "" | "<no value>") sha=unknown ;; esac
  line="{\"time\":$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)"),\"action\":$(json_str "$ACTION"),\"release\":$(json_str "$REC_RELEASE"),\"image\":$(json_str "$REC_IMAGE"),\"digest\":$(json_str "$REC_DIGEST"),\"git_sha\":$(json_str "$sha"),\"result\":$(json_str "$1"),\"who\":$(json_str "$who")}"
  mkdir -p "$STATE"
  local log="$STATE/deploys.jsonl"
  (umask 077 && touch "$log") && chmod 600 "$log"
  printf '%s\n' "$line" >>"$log"
  if [ "$(wc -l <"$log")" -gt 1000 ]; then tail -n 1000 "$log" >"$log.tmp" && chmod 600 "$log.tmp" && mv "$log.tmp" "$log"; fi
  if [ -n "${AGFN_DEPLOY_LOG_GROUP:-}" ]; then
    local stream ms
    stream=$(hostname 2>/dev/null || echo agfn)
    ms=$(( $(date +%s) * 1000 ))
    aws logs create-log-stream --log-group-name "$AGFN_DEPLOY_LOG_GROUP" --log-stream-name "$stream" >/dev/null 2>&1 || true
    aws logs put-log-events --log-group-name "$AGFN_DEPLOY_LOG_GROUP" --log-stream-name "$stream" \
      --log-events "[{\"timestamp\":$ms,\"message\":$(json_str "$line")}]" >/dev/null 2>&1 \
      || echo "[deploy-aws] warning: the deploy record didn't reach CloudWatch ($AGFN_DEPLOY_LOG_GROUP); it is in $log" >&2
  fi
  REC_IMAGE="" # one record per run
}

# ---------- env file ----------

TMP_ENV=""
cleanup() { [ -n "$TMP_ENV" ] && rm -f "$TMP_ENV"; return 0; }
trap cleanup EXIT

ENVF=""
env_file() { # sets ENVF (not in a subshell, so the EXIT trap removes a temporary file)
  if [ -n "${AGFN_ENV_FILE:-}" ]; then
    [ -r "$AGFN_ENV_FILE" ] || die "AGFN_ENV_FILE $AGFN_ENV_FILE is not readable"
    ENVF=$AGFN_ENV_FILE
    return
  fi
  [ -n "${AGFN_SSM_PATH:-}" ] || die "set AGFN_ENV_FILE or AGFN_SSM_PATH"
  TMP_ENV=$(umask 077 && mktemp "${TMPDIR:-/tmp}/agfn-env.XXXXXX")
  # Name<TAB>Value per line; the env file gets KEY=value with KEY the last path segment. Docker's env-file is one line
  # per variable, so a multi-line value is refused rather than cut.
  local raw
  raw=$(aws ssm get-parameters-by-path --path "$AGFN_SSM_PATH" --recursive --with-decryption \
    --query 'Parameters[].[Name,Value]' --output text) || die "reading $AGFN_SSM_PATH from Parameter Store"
  [ -n "$raw" ] || die "no parameters under $AGFN_SSM_PATH"
  printf '%s\n' "$raw" | awk -F'\t' 'NF < 2 { bad = 1; next } { n = split($1, p, "/"); k = p[n]; v = substr($0, length($1) + 2); if (k !~ /^[A-Z_][A-Z0-9_]*$/) { bad = 1; next } print k "=" v } END { exit bad }' >"$TMP_ENV" \
    || die "a parameter under $AGFN_SSM_PATH has a bad name or a multi-line value (names only are checked; nothing printed)"
  ENVF=$TMP_ENV
}

# ---------- which side serves ----------

serving_port() { # the blue or green port upstream.caddy points at, or empty
  local p
  p=$( { sed -n 's/^[[:space:]]*to 127\.0\.0\.1:\([0-9][0-9]*\)[[:space:]]*$/\1/p' "$CADDY_DIR/upstream.caddy" 2>/dev/null || true; } | head -1)
  case "$p" in "$BLUE_PORT" | "$GREEN_PORT") echo "$p" ;; esac
}
color_of() { [ "$1" = "$BLUE_PORT" ] && echo blue || echo green; }

healthy() { # port -> waits up to HEALTH_S for 200
  local deadline=$(( $(date +%s) + HEALTH_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/healthz" || true)" = "200" ] && return 0
    sleep 2
  done
  return 1
}

# The container must publish its app port on loopback and nothing else (no 9091, no 0.0.0.0).
published_ok() { # container port
  local ports
  ports=$("$DOCKER" port "$1")
  [ "$ports" = "8787/tcp -> 127.0.0.1:$2" ] || { echo "$ports" >&2; return 1; }
}

# Nothing on the host listens on the metrics port outside loopback.
metrics_closed() {
  if command -v ss >/dev/null 2>&1; then
    ! ss -Hltn 'sport = :9091' | awk '{print $4}' | grep -qv '^127\.0\.0\.1:'
  else
    ! (lsof -nP -iTCP:9091 -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {print $9}' | grep -qv '^127\.0\.0\.1:')
  fi
}

# ---------- deploy ----------

deploy() {
  local image=$1
  [ -n "$image" ] || die "usage: deploy-aws.sh deploy <image>"
  REC_IMAGE=$image
  mkdir -p "$STATE"
  env_file
  local release
  release="$(printf '%s' "${image##*[:@]}" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-40)-$(date -u +%Y%m%dT%H%M%SZ)"
  REC_RELEASE=$release

  local old_port new_port
  old_port=$(serving_port)
  if [ "$old_port" = "$BLUE_PORT" ]; then new_port=$GREEN_PORT; else new_port=$BLUE_PORT; fi
  local old="$NAME-$(color_of "${old_port:-$GREEN_PORT}")" new="$NAME-$(color_of "$new_port")"
  say "image $image, release $release; serving: $([ -n "$old_port" ] && echo "$old on $old_port" || echo nothing); new: $new on $new_port"

  if [ "${AGFN_NO_PULL:-}" = "1" ]; then
    say "1/6 pull skipped (AGFN_NO_PULL=1: a local image)"
    "$DOCKER" image inspect "$image" >/dev/null 2>&1 || die "no local image $image"
  else
    say "1/6 pull"
    "$DOCKER" pull -q "$image" >/dev/null || die "pull $image"
  fi
  REC_DIGEST=$("$DOCKER" image inspect --format '{{ if .RepoDigests }}{{ index .RepoDigests 0 }}{{ else }}{{ .Id }}{{ end }}' "$image" 2>/dev/null || true)

  say "2/6 release step (migrations) — the old container keeps serving if this fails"
  # shellcheck disable=SC2086
  "$DOCKER" run --rm --name "$NAME-release" --env-file "$ENVF" -e AGFN_RELEASE="$release" ${AGFN_DOCKER_ARGS:-} \
    "$image" node apps/server/src/release.ts || die "release step failed; nothing switched, ${old_port:+$old still serving}"

  say "3/6 start $new"
  # A stopped container of that colour is the deploy before last: its image stays in state/previous-image.
  "$DOCKER" rm -f "$new" >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  "$DOCKER" run -d --name "$new" --restart unless-stopped --env-file "$ENVF" -e AGFN_RELEASE="$release" \
    -p "127.0.0.1:$new_port:8787" ${AGFN_DOCKER_ARGS:-} "$image" >/dev/null || die "start $new"
  if ! published_ok "$new" "$new_port"; then
    "$DOCKER" rm -f "$new" >/dev/null 2>&1 || true
    die "$new publishes more than 127.0.0.1:$new_port (AGFN_DOCKER_ARGS?); removed it, nothing switched"
  fi

  say "4/6 wait for $new /healthz (up to ${HEALTH_S}s)"
  if ! healthy "$new_port"; then
    "$DOCKER" logs --tail 40 "$new" 2>&1 | sed 's/^/  | /' >&2 || true
    "$DOCKER" rm -f "$new" >/dev/null 2>&1 || true
    die "$new never became healthy; removed it, nothing switched${old_port:+, $old still serving}"
  fi

  say "5/6 switch Caddy to $new_port"
  local up="$CADDY_DIR/upstream.caddy"
  [ -f "$up" ] && cp "$up" "$up.prev"
  printf 'to 127.0.0.1:%s\n' "$new_port" >"$up.tmp" && mv "$up.tmp" "$up"
  if ! sh -c "$RELOAD"; then
    if [ -f "$up.prev" ]; then mv "$up.prev" "$up"; else rm -f "$up"; fi
    "$DOCKER" rm -f "$new" >/dev/null 2>&1 || true
    die "Caddy reload failed; upstream restored, $new removed"
  fi

  # Record images: the one that served before becomes previous (kept for rollback, never pruned here).
  [ -f "$STATE/current-image" ] && cp "$STATE/current-image" "$STATE/previous-image"
  printf '%s\n' "$image" >"$STATE/current-image"
  printf '%s\n' "$release" >"$STATE/current-release"

  if [ -n "$old_port" ] && "$DOCKER" inspect "$old" >/dev/null 2>&1; then
    say "6/6 drain $old for ${DRAIN}s, then stop it (kept until the next deploy)"
    sleep "$DRAIN"
    "$DOCKER" stop -t 30 "$old" >/dev/null || say "stopping $old failed; it no longer gets traffic"
  else
    say "6/6 no old container"
  fi

  if ! metrics_closed; then
    record "ok, but :9091 listens beyond loopback"
    echo "[deploy-aws] FAILED: something listens on :9091 beyond loopback; close it (the deploy itself is done)" >&2
    exit 1
  fi
  record ok
  say "ok: $new serves $image (release $release)"
}

case "${1:-}" in
  deploy) deploy "${2:-}" ;;
  rollback)
    prev=$(cat "$STATE/previous-image" 2>/dev/null || true)
    [ -n "$prev" ] || die "no previous image recorded in $STATE"
    ACTION=rollback
    say "rolling back to $prev (a fresh release id, so its worker counts as newest)"
    deploy "$prev"
    ;;
  status)
    p=$(serving_port)
    echo "serving: $([ -n "$p" ] && echo "$NAME-$(color_of "$p") on 127.0.0.1:$p" || echo nothing)"
    echo "current: $(cat "$STATE/current-image" 2>/dev/null || echo none) ($(cat "$STATE/current-release" 2>/dev/null || echo -))"
    echo "previous: $(cat "$STATE/previous-image" 2>/dev/null || echo none)"
    ;;
  *) echo "usage: deploy-aws.sh deploy <image> | rollback | status" >&2; exit 2 ;;
esac
