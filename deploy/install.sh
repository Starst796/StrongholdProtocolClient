#!/usr/bin/env bash
# Install (or remove) push-triggered auto-deploy on the server. Run once, with sudo.
#
# Two modes; both end in the same place (announce in game → restart → verify /healthz):
#
#   hook  (default) — a git post-receive hook fires the moment you push to the server repo:
#       sudo deploy/install.sh --mode hook --repo /home/ubuntu/webUI/Stronghold-Protocol
#       then a release is:  git push <your-fork> master && git push workplace master
#     Zero delay, and the pusher sees the deploy log. Needs the server repo to accept pushes
#     (receive.denyCurrentBranch=ignore) and passwordless sudo for the repo owner.
#
#   timer — a systemd timer polls a git remote every 2 minutes and pulls:
#       sudo deploy/install.sh --mode timer --repo <checkout> --remote https://gh-proxy.com/https://github.com/<you>/Stronghold-Protocol.git
#     No write access needed on the server repo, but up to ~2 minutes of lag.
#
# Run it from wherever you keep this folder (e.g. scp it to the server, or run it from the packaging repo).
#
# Other options:
#   --repo <path>   the game checkout to deploy — required on the first install (later ones read it back from
#                   the config file; the old "the checkout next to this script" default is gone, since this
#                   script now lives in the packaging repo, not in the game checkout)
#   --branch master the branch that deploys
#   --lead 60       seconds of in-game warning before the restart (0 = none)
#   --status        what is installed right now
#   --off           remove the timer and/or the hook (leaves the config file)
#
# Both modes share /etc/default/stronghold-deploy (SP_DEPLOY_* — see deploy.sh --help) and install a copy of
# deploy.sh at /usr/local/bin/stronghold-deploy.sh for manual runs.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${SP_DEPLOY_CONF:-/etc/default/stronghold-deploy}"

# This script lives in the client packaging repo, so "the checkout next to me" means nothing any more: the game
# checkout comes from --repo, or from the shared config the previous install wrote.
MODE="hook"
REMOTE=""
REPO=""
BRANCH="master"
LEAD="60"
OFF=0
STATUS=0
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
REPO="${SP_DEPLOY_REPO:-}"
BRANCH="${SP_DEPLOY_BRANCH:-master}"
LEAD="${SP_DEPLOY_LEAD:-60}"

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2;;
    --remote) REMOTE="$2"; shift 2;;
    --repo) REPO="$(cd "$2" && pwd)"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --lead) LEAD="$2"; shift 2;;
    --off) OFF=1; shift;;
    --status) STATUS=1; shift;;
    -h|--help) sed -n '2,29p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 1;;
  esac
done
case "$MODE" in hook|timer) ;; *) echo "--mode must be hook or timer" >&2; exit 1;; esac
HOOK="${REPO:+$REPO/.git/hooks/post-receive}"

if [ "$STATUS" -eq 1 ]; then
  echo "--- deploy script: /usr/local/bin/stronghold-deploy.sh"; ls -l /usr/local/bin/stronghold-deploy.sh 2>/dev/null || echo "(missing)"
  echo "--- config: $CONF"; cat "$CONF" 2>/dev/null || echo "(missing)"
  echo "--- timer: $(systemctl is-enabled stronghold-deploy.timer 2>/dev/null || echo '(not installed)')"
  systemctl list-timers stronghold-deploy.timer --no-pager 2>/dev/null || true
  echo "--- repo: $REPO"
  echo "--- hook: $HOOK"; ls -l "$HOOK" 2>/dev/null || echo "(not installed)"
  if [ -f "$HOOK" ]; then
    echo "--- last hook run:"; tail -n 20 "$REPO/.git/stronghold-deploy.log" 2>/dev/null || echo "(no log yet)"
  fi
  echo "--- denyCurrentBranch: $(git -C "$REPO" config --get receive.denyCurrentBranch 2>/dev/null || echo '(unset)')"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || { echo "run me with sudo" >&2; exit 1; }

# Both modes record the checkout in the config, so it is required (the old "next to this script" default is gone).
if [ -z "$REPO" ]; then
  echo "need the game checkout: pass --repo <dir> (or set SP_DEPLOY_REPO in $CONF, or --repo on the first install)" >&2
  exit 1
fi
[ -d "$REPO/.git" ] || { echo "not a git checkout: $REPO" >&2; exit 1; }

REPO_OWNER="$(stat -c '%U' "$REPO")"
# .git/config and .git/hooks must stay owned by whoever runs git in the repo, or the next push breaks.
asowner() {
  if [ "$(id -un)" = "$REPO_OWNER" ]; then "$@"
  elif command -v runuser >/dev/null; then runuser -u "$REPO_OWNER" -- "$@"
  else sudo -u "$REPO_OWNER" -- "$@"; fi
}

if [ "$OFF" -eq 1 ]; then
  systemctl disable --now stronghold-deploy.timer 2>/dev/null || true
  rm -f /etc/systemd/system/stronghold-deploy.timer /etc/systemd/system/stronghold-deploy.service
  systemctl daemon-reload 2>/dev/null || true
  if [ -f "$HOOK" ]; then rm -f "$HOOK"; echo "post-receive hook removed from $HOOK"; fi
  asowner git -C "$REPO" config --unset receive.denyCurrentBranch 2>/dev/null || true
  echo "auto-deploy removed (the deploy script and $CONF are left in place)"
  exit 0
fi

install -m 755 "$HERE/deploy.sh" /usr/local/bin/stronghold-deploy.sh
# Defensive: a checkout could have handed us CRLF, and `\r` breaks a Linux shebang/`case` pattern.
sed -i 's/\r$//' /usr/local/bin/stronghold-deploy.sh

if [ "$MODE" = "timer" ]; then
  [ -n "$REMOTE" ] || { echo "--mode timer needs --remote <git url> (the repo the server should pull from)" >&2; exit 1; }
  install -m 644 "$HERE/stronghold-deploy.service" /etc/systemd/system/stronghold-deploy.service
  install -m 644 "$HERE/stronghold-deploy.timer" /etc/systemd/system/stronghold-deploy.timer
  # systemd mis-parses unit files with CRLF ("... is not a valid unit name"), so strip CR from a Windows checkout.
  sed -i 's/\r$//' /etc/systemd/system/stronghold-deploy.service /etc/systemd/system/stronghold-deploy.timer
else
  # Non-bare repo with the branch checked out: git refuses pushes unless told otherwise. The hook does the update
  # ("ignore"), not "updateInstead", because the running server keeps rewriting the tracked data/assets.json.
  asowner git -C "$REPO" config receive.denyCurrentBranch ignore
  install -m 755 -o "$REPO_OWNER" -g "$REPO_OWNER" "$HERE/hooks/post-receive" "$HOOK"
  sed -i 's/\r$//' "$HOOK"
  echo "post-receive hook installed at $HOOK"
fi

cat > "$CONF" <<EOF
# Auto-deploy configuration (see deploy/deploy.sh --help). After editing:
#   sudo systemctl restart stronghold-deploy.timer    # timer mode
#   (hook mode reads it on the next push)
SP_DEPLOY_REPO=$REPO
SP_DEPLOY_BRANCH=$BRANCH
SP_DEPLOY_SERVICE=stronghold
SP_DEPLOY_LEAD=$LEAD
# Wait up to this many seconds for running matches to drop to SP_DEPLOY_MAX_MATCHES before restarting (0 = never).
SP_DEPLOY_MAX_WAIT=0
SP_DEPLOY_MAX_MATCHES=0
# Roll the working tree back automatically if the new build fails its health check (hook mode).
SP_DEPLOY_ROLLBACK=1
EOF
[ -n "$REMOTE" ] && echo "SP_DEPLOY_REMOTE=$REMOTE" >> "$CONF"
echo "wrote $CONF"

if [ "$MODE" = "timer" ]; then
  systemctl daemon-reload
  systemctl enable --now stronghold-deploy.timer
  echo "installed (timer). A push to $REMOTE ($BRANCH) is deployed within ~2 minutes; watch 'journalctl -u stronghold-deploy -f'."
else
  # The hook replaces the timer; leaving both would restart the service twice per release.
  systemctl disable --now stronghold-deploy.timer 2>/dev/null || true
  echo "installed (hook). A release is now two pushes:"
  echo "    git push <your-fork> $BRANCH          # history, for everyone else"
  echo "    git push workplace $BRANCH            # deploy: announce → restart → verify, right in the push output"
fi
echo "manual run (no restart of the tree): sudo stronghold-deploy.sh --lead 0 --dry-run"
