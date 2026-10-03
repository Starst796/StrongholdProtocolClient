#!/usr/bin/env bash
# Bring a Stronghold Protocol server release live: announce → (pull) → restart → verify.
#
# Two ways to use it, both sharing this one implementation:
#
#   A) push-triggered (scripts/deploy/hooks/post-receive, installed by `install.sh --mode hook`)
#        scripts/deploy/deploy.sh --pushed --from <oldrev> --to <newrev>
#      The hook has already forced the working tree to <newrev>; this announces, restarts and verifies.
#
#   B) polling (stronghold-deploy.timer, installed by `install.sh --mode timer`)
#        scripts/deploy/deploy.sh [--remote <git url>] [--branch master]
#      Fetches, fast-forwards, then announces, restarts and verifies.
#
# Options:
#   --lead N       publish an in-game "维护重启" notice N seconds before restarting (scripts/notice.mjs → the file
#                  server/notice.js polls; publishing needs no restart). Default 60, 0 = no announcement. Skipped
#                  automatically while that feature is not deployed yet.
#   --max-wait N   wait up to N seconds for running matches to drop to --max-matches before restarting (0 = never
#                  wait — the announcement is the warning). --force skips the wait.
#   --dry-run      show what would happen, change nothing.
#
# Exit codes: 0 = deployed (or nothing to do), 1 = failed (pull/health), 2 = nothing happened (busy/dry run).
# Everything goes to stdout: in the hook the pusher sees it, under systemd it lands in the journal.

set -euo pipefail

# If this runs from a git hook, GIT_DIR/GIT_WORK_TREE point at the repository's .git and would override the
# working-tree commands below (git then reports "not a git repository: '.'").
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES

# The install puts this script at /usr/local/bin, where "the checkout next to me" is meaningless, so read the
# configuration the hook and the timer share. Command-line flags still win (they are parsed after this).
SP_DEPLOY_CONF="${SP_DEPLOY_CONF:-/etc/default/stronghold-deploy}"
# shellcheck disable=SC1090
[ -f "$SP_DEPLOY_CONF" ] && . "$SP_DEPLOY_CONF"

REMOTE="${SP_DEPLOY_REMOTE:-}"
BRANCH="${SP_DEPLOY_BRANCH:-master}"
SERVICE="${SP_DEPLOY_SERVICE:-stronghold}"
REPO="${SP_DEPLOY_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
LEAD="${SP_DEPLOY_LEAD:-60}"
MAX_WAIT="${SP_DEPLOY_MAX_WAIT:-0}"
MAX_MATCHES="${SP_DEPLOY_MAX_MATCHES:-0}"
PUSHED=0
FROM=""
TO=""
FORCE=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --remote) REMOTE="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --service) SERVICE="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --lead) LEAD="$2"; shift 2;;
    --max-wait) MAX_WAIT="$2"; shift 2;;
    --max-matches) MAX_MATCHES="$2"; shift 2;;
    --pushed) PUSHED=1; shift;;
    --from) FROM="${2:-}"; shift 2;;
    --to) TO="${2:-}"; shift 2;;
    --force) FORCE=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) sed -n '2,25p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 1;;
  esac
done

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

[ -d "$REPO/.git" ] || die "not a git checkout: $REPO"
cd "$REPO"

# ---- what is deployed right now ----------------------------------------------------------------------------------
HEALTH_URL="${SP_DEPLOY_HEALTH_URL:-http://127.0.0.1:${PORT:-3000}/healthz}"
# A busy server (hundreds of live sockets) can be slow to answer, so allow more than one attempt.
health() { curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null || true; }
# "humans matches" from /healthz, or nothing when the server is unreachable.
counts() { health | sed -n 's/.*"matches":\([0-9]*\).*"humans":\([0-9]*\).*/\2 \1/p'; }
uptime_of() { printf '%s' "$1" | sed -n 's/.*"uptimeSec":\([0-9]*\).*/\1/p'; }

BEFORE_UPTIME=""
for _ in 1 2 3; do
  BEFORE_UPTIME="$(uptime_of "$(health)")"
  [ -n "$BEFORE_UPTIME" ] && break
  sleep 2
done
log "repo=$REPO branch=$BRANCH service=$SERVICE health=$HEALTH_URL uptimeSec=${BEFORE_UPTIME:-?}"
# Without a "before" reading we cannot prove the restart happened, so fall back to "it answers again" and say so.
[ -n "$BEFORE_UPTIME" ] || log "WARNING: $HEALTH_URL did not answer before the restart — verification will only check that it comes back"

# ---- resolve what to deploy --------------------------------------------------------------------------------------
CURRENT="$(git rev-parse HEAD)"
if [ "$PUSHED" -eq 1 ]; then
  # The hook force-updated the working tree: HEAD is already the new commit, so the *range* starts at FROM.
  TARGET="${TO:-$CURRENT}"
  DIFF_FROM="${FROM:-}"
  if [ -n "$DIFF_FROM" ] && git cat-file -e "$DIFF_FROM^{commit}" 2>/dev/null; then
    log "hook already updated the working tree: $(git rev-parse --short "$DIFF_FROM") → $(git rev-parse --short "$TARGET")"
    git --no-pager log --oneline "$DIFF_FROM..$TARGET" 2>/dev/null | sed 's/^/    /' || true
  else
    DIFF_FROM="$(git rev-parse "$TARGET^" 2>/dev/null || echo "$TARGET")"
    log "deploying $(git rev-parse --short "$CURRENT") (no --from: dependency check against the previous commit)"
  fi
else
  if [ -n "$REMOTE" ]; then
    log "fetching $REMOTE ($BRANCH)"
    git fetch --quiet "$REMOTE" "$BRANCH" || die "git fetch failed (network?)"
    TARGET="$(git rev-parse FETCH_HEAD)"
  else
    log "fetching the configured upstream (git fetch --all)"
    git fetch --quiet --all || die "git fetch failed (network?)"
    TARGET="$(git rev-parse "origin/$BRANCH" 2>/dev/null || true)"
  fi
  [ -n "$TARGET" ] || die "cannot resolve the target commit (branch $BRANCH)"
  if [ "$TARGET" = "$CURRENT" ]; then
    log "already at $(git rev-parse --short HEAD) — nothing to deploy"
    exit 0
  fi
  log "deploying $(git rev-parse --short "$CURRENT") → $(git rev-parse --short "$TARGET")"
  git --no-pager log --oneline "$CURRENT..$TARGET" | sed 's/^/    /'
  DIFF_FROM="$CURRENT"
  # The running server rewrites this tracked file (the asset manifest it builds); a pull must not fight it.
  if ! git diff --quiet -- data/assets.json 2>/dev/null; then
    log "data/assets.json has local changes (the running server owns it) — restoring it before the pull"
    [ "$DRY_RUN" -eq 1 ] || git checkout -- data/assets.json
  fi
fi

# ---- wait for a quiet moment (only when asked to) -----------------------------------------------------------------
if [ "$FORCE" -eq 0 ] && [ "$MAX_WAIT" -gt 0 ]; then
  waited=0
  while [ "$waited" -lt "$MAX_WAIT" ]; do
    read -r humans matches <<<"$(counts || echo '')"
    if [ -z "${matches:-}" ] || [ "$matches" -le "$MAX_MATCHES" ]; then break; fi
    log "waiting for a quiet moment: $matches match(es), $humans player(s) (${waited}s/${MAX_WAIT}s)"
    sleep 15; waited=$((waited + 15))
  done
fi

# ---- announce, then restart --------------------------------------------------------------------------------------
ANNOUNCED=0
if [ "$LEAD" -gt 0 ] && command -v node >/dev/null && [ -f scripts/notice.mjs ]; then
  if node scripts/notice.mjs --kind maintenance --for "$((LEAD + 120))s" \
       "服务器将在约 ${LEAD} 秒后维护重启（新版本上线），预计 1 分钟，稍后会自动重连" >/dev/null 2>&1; then
    ANNOUNCED=1
    log "announced the restart in game; waiting ${LEAD}s so players see it"
    sleep "$LEAD"
  else
    log "could not publish an in-game notice (feature not deployed yet?) — restarting now"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  [ "$PUSHED" -eq 1 ] || log "dry run: would 'git merge --ff-only $(git rev-parse --short "$TARGET")'"
  log "dry run: would restart $SERVICE"
  exit 2
fi

if [ "$PUSHED" -eq 0 ]; then
  git merge --ff-only --quiet "$TARGET" || die "not a fast-forward: the checkout has local commits (resolve by hand)"
fi
log "tree at $(git rev-parse --short HEAD)"

# Dependencies only when the manifest changed — a deploy must not sit on npm for a minute when nothing needs it.
if [ -n "$DIFF_FROM" ] && git diff --name-only "$DIFF_FROM" HEAD 2>/dev/null | grep -qE '^(package\.json|package-lock\.json)$'; then
  log "package manifest changed — npm ci --omit=dev"
  npm ci --omit=dev --no-audit --no-fund || die "npm ci failed"
fi

sudo systemctl restart "$SERVICE" || die "systemctl restart $SERVICE failed"
log "restarted $SERVICE; waiting for it to answer $HEALTH_URL"

# ---- verify ------------------------------------------------------------------------------------------------------
for _ in $(seq 1 "${SP_DEPLOY_TRIES:-30}"); do
  sleep 1
  body="$(health)"
  [ -n "$body" ] || continue
  after="$(uptime_of "$body")"
  app="$(printf '%s' "$body" | sed -n 's/.*"app":"\([^"]*\)".*/\1/p')"
  players="$(printf '%s' "$body" | sed -n 's/.*"humans":\([0-9]*\).*/\1/p')"
  if [ -z "$after" ]; then continue; fi
  if [ -n "$BEFORE_UPTIME" ] && [ "$after" -ge "$BEFORE_UPTIME" ]; then
    continue   # still the old process: keep waiting for the restart to show up
  fi
  if [ -n "$BEFORE_UPTIME" ]; then
    log "OK: restarted, uptimeSec $BEFORE_UPTIME → $after, app $app, ${players:-?} player(s)"
  else
    log "OK: back online (uptimeSec $after, app $app, ${players:-?} player(s)) — the restart itself was not verifiable"
  fi
  # Take the maintenance banner down: its `until` is still minutes away, so everyone reconnecting after the restart
  # would otherwise be told a restart is coming that has already happened.
  if [ "$ANNOUNCED" -eq 1 ]; then
    if node scripts/notice.mjs --clear >/dev/null 2>&1; then
      log "cleared the maintenance notice"
    else
      log "could not clear the maintenance notice — run: node scripts/notice.mjs --clear"
    fi
  fi
  exit 0
done
die "the server did not come back on the new build — journalctl -u $SERVICE -n 50"
