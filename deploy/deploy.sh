#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  deploy.sh — pull, build and publish Jarvis on the EC2 box
#
#  Run on the box, as the user that owns the code (ubuntu on Ubuntu,
#  ec2-user on Amazon Linux) — not as root:
#
#     ~/prod/deploy/deploy.sh          the API, the staff web app and the portal
#     ~/prod/deploy/deploy.sh api      the API only
#     ~/prod/deploy/deploy.sh web      the staff web app and the portal only
#
#  What it does, in this order, stopping at the first thing that fails:
#
#    1. Checks the box: tools, Node 20+, the env file, the service, disk.
#    2. Fetches origin/main for ~/prod and ~/prod_web and checks each can
#       simply move forward (a box with local edits is refused, never
#       overwritten). The web code moves now; the server code waits for
#       step 4, so the running API does not sit on new files for the
#       minutes the web build takes.
#    3. Builds the web app and the portal — before anything live changes,
#       so a build that fails leaves the site exactly as it was.
#    4. API: moves the code forward, installs packages (only when the
#       lockfile changed), runs the database migrations, restarts the
#       service and waits until it answers with the database connected.
#    5. Publishes the two web builds: the new hashed files first, the page
#       that names them second, so no browser is ever sent a page that
#       points at files not there yet.
#    6. Checks the public addresses and prints what was deployed.
#
#  First-time setup of a new box (Node, MongoDB, the env file, the
#  service, Caddy, DNS) is deploy/EC2_SETUP.md. This script is for every
#  deploy after that.
#
#  Settings (environment variables, all optional):
#    BRANCH=main               what to deploy
#    API_DIR=~/prod            WEB_DIR=~/prod_web
#    API_SERVICE=jarvis        the systemd unit
#    ERP_ROOT=/var/www/erp     PORTAL_ROOT=/var/www/portal
#    API_URL=https://api.baluelastics.com
#    ERP_URL=https://erp.baluelastics.com
#    PORTAL_URL=https://portal.baluelastics.com
#    SKIP_PULL=1               build and publish what is already checked out
#    SKIP_PUBLIC_CHECK=1       skip step 6 (e.g. before DNS points here)
#    READY_WAIT=90             seconds to wait for the API after the restart
# ══════════════════════════════════════════════════════════════════

set -Eeuo pipefail

# This file lives in the checkout it updates. Bash reads a script as it
# runs, so it runs from a copy taken now: the deploy never executes
# lines from a file it has just replaced.
SELF="${JARVIS_DEPLOY_SELF:-$(readlink -f "$0")}"
if [[ -z "${JARVIS_DEPLOY_COPY:-}" ]]; then
  copy=$(mktemp /tmp/jarvis-deploy.XXXXXX)
  cp "$SELF" "$copy"
  JARVIS_DEPLOY_COPY="$copy" JARVIS_DEPLOY_SELF="$SELF" exec bash "$copy" "$@"
fi
trap 'rm -f "$JARVIS_DEPLOY_COPY"' EXIT

WHAT="${1:-all}"
case "$WHAT" in
  all|api|web) ;;
  -h|--help|help) sed -n '2,/^# ═/p' "$SELF"; exit 0 ;;
  *) echo "Usage: $SELF [all|api|web]" >&2; exit 2 ;;
esac
DO_API=0; DO_WEB=0
[[ "$WHAT" == all || "$WHAT" == api ]] && DO_API=1
[[ "$WHAT" == all || "$WHAT" == web ]] && DO_WEB=1

BRANCH="${BRANCH:-main}"
API_DIR="${API_DIR:-$HOME/prod}"
WEB_DIR="${WEB_DIR:-$HOME/prod_web}"
API_SERVICE="${API_SERVICE:-jarvis}"
ERP_ROOT="${ERP_ROOT:-/var/www/erp}"
PORTAL_ROOT="${PORTAL_ROOT:-/var/www/portal}"
API_URL="${API_URL:-https://api.baluelastics.com}"
ERP_URL="${ERP_URL:-https://erp.baluelastics.com}"
PORTAL_URL="${PORTAL_URL:-https://portal.baluelastics.com}"
SKIP_PULL="${SKIP_PULL:-0}"
SKIP_PUBLIC_CHECK="${SKIP_PUBLIC_CHECK:-0}"
READY_WAIT="${READY_WAIT:-90}"

# ── Output: on screen and in a log kept for each run ──────────────
LOG_DIR="$HOME/deploy-logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
# Keep the last 30 logs.
ls -1t "$LOG_DIR"/deploy-*.log 2>/dev/null | tail -n +31 | xargs -r rm -f || true

STARTED=$(date +%s)
STEP="starting"
step() { STEP="$*"; printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '   • %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; WARNINGS+=("$*"); }
WARNINGS=()

API_PREV=""; API_NEW=""; WEB_PREV=""; WEB_NEW=""
API_MOVED=0; API_RESTARTED=0; WEB_PUBLISHED=0

# Where things stand when a deploy stops part way: printed whether it
# stopped on a check (die) or on a command that failed (the ERR trap).
where_we_are() {
  if (( API_MOVED && ! API_RESTARTED )) && [[ "$API_PREV" != "$API_NEW" ]]; then
    echo "  The server code on disk is now ${API_NEW:0:7}, but the service is still running ${API_PREV:0:7}"
    echo "  until it restarts. Fix the problem and run this again — or put the code back with:"
    echo "    git -C $API_DIR checkout --quiet $API_PREV"
  fi
  (( WEB_PUBLISHED )) || echo "  Nothing was published to $ERP_ROOT or $PORTAL_ROOT."
  echo "  Full log: $LOG"
}
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*"; where_we_are; exit 1; }
on_error() {
  local code=$? line=$1
  # A command failing inside $( … ) reaches the trap too; whether that
  # stops the deploy is the main shell's business, and it says so then.
  (( BASH_SUBSHELL == 0 )) || return 0
  printf '\n\033[31m✗ Stopped while: %s (line %s, exit %s)\033[0m\n' "$STEP" "$line" "$code"
  where_we_are
}
trap 'on_error $LINENO' ERR

# One deploy at a time: a second one waits for the first to finish.
exec 9>"/tmp/jarvis-deploy.lock"
if ! flock -n 9; then
  echo "Another deploy is running; waiting for it to finish…"
  flock 9
fi

# ── 1. The box ────────────────────────────────────────────────────
step "1. Checking the box"

[[ $(id -u) -ne 0 ]] || die "Run this as the user that owns the code (ubuntu / ec2-user), not as root: the code, its packages and the logs would end up owned by root."

pkg_install() {
  if command -v apt-get >/dev/null; then sudo apt-get install -y "$@" >/dev/null
  elif command -v dnf >/dev/null; then sudo dnf install -y "$@" >/dev/null
  else die "Install $* and run this again."; fi
}
for tool in git node npm curl; do
  command -v "$tool" >/dev/null || die "'$tool' is not installed. deploy/EC2_SETUP.md step 2 installs it."
done
if (( DO_WEB )) && ! command -v rsync >/dev/null; then
  note "Installing rsync (used to publish the web builds)"
  if command -v apt-get >/dev/null; then sudo apt-get update -qq; fi
  pkg_install rsync
fi
sudo -v || die "This needs sudo (to restart the service and publish the web files)."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 20 )) || die "Node $(node -v) is too old; the server needs 20 or later (deploy/EC2_SETUP.md step 2)."
ok "Node $(node -v), npm $(npm -v)"

if (( DO_API )); then
  [[ -d "$API_DIR/.git" ]] || die "$API_DIR is not a checkout of the server (deploy/EC2_SETUP.md step 3)."
  [[ -f "$API_DIR/config/.env" ]] || die "$API_DIR/config/.env is missing (deploy/EC2_SETUP.md step 6)."
  systemctl cat "$API_SERVICE" >/dev/null 2>&1 || die "The '$API_SERVICE' service is not installed (deploy/EC2_SETUP.md step 8)."
  # The port the API listens on, as the env file sets it (2701 when it does not).
  API_PORT=$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?PORT[[:space:]]*=[[:space:]]*["'\'']?([0-9]+).*/\2/p' "$API_DIR/config/.env" | tail -1)
  API_PORT="${API_PORT:-2701}"
  ok "API: $API_DIR, service '$API_SERVICE', port $API_PORT"
fi
if (( DO_WEB )); then
  [[ -d "$WEB_DIR/.git" ]] || die "$WEB_DIR is not a checkout of the web app (deploy/EC2_SETUP.md step 3)."
  ok "Web: $WEB_DIR → $ERP_ROOT and $PORTAL_ROOT"
  # The web build needs memory; on a small box without swap it is killed half way.
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  swap_mb=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
  if (( mem_mb + swap_mb < 3000 )); then
    warn "Only ${mem_mb} MB of memory and ${swap_mb} MB of swap: the web build may be killed. deploy/EC2_SETUP.md step 2 adds 2 GB of swap."
  fi
fi
free_mb=$(df -Pm "$HOME" | awk 'NR==2 {print $4}')
(( free_mb > 1500 )) || die "Only ${free_mb} MB free on the disk; the install and build need about 1.5 GB (deploy/EC2_SETUP.md step 14 grows the volume)."
ok "${free_mb} MB free on disk"

# ── 2. The code ───────────────────────────────────────────────────
# check_code <dir> <name>: refuses local edits, fetches, and works out
# where the checkout will move to — without moving it. Sets CODE_PREV / CODE_NEW.
check_code() {
  local dir=$1 name=$2
  cd "$dir"
  CODE_PREV=$(git rev-parse HEAD)
  if [[ "$SKIP_PULL" == 1 ]]; then
    CODE_NEW=$CODE_PREV
    note "$name: left at ${CODE_NEW:0:7} (SKIP_PULL=1)"
    return 0
  fi
  # Edits made on the box are not thrown away. (Untracked files such as
  # config/.env, dist/ and node_modules/ are not counted: they are meant to be there.)
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    git status --short --untracked-files=no
    die "$name has local edits (above). Commit them somewhere or undo them (git -C $dir checkout -- <file>), then run this again."
  fi
  git fetch --quiet origin "$BRANCH"
  CODE_NEW=$(git rev-parse "origin/$BRANCH")
  git merge-base --is-ancestor HEAD "$CODE_NEW" \
    || die "$name: the checkout has commits that are not on origin/$BRANCH, so it cannot simply move forward. Look with: git -C $dir log --oneline origin/$BRANCH..HEAD"
  if [[ "$CODE_PREV" == "$CODE_NEW" ]]; then
    ok "$name: already at ${CODE_NEW:0:7}"
  else
    ok "$name: ${CODE_PREV:0:7} → ${CODE_NEW:0:7} ($(git rev-list --count "$CODE_PREV..$CODE_NEW") commits)"
  fi
}

# advance_code <dir> <new>: moves the checkout onto <new>, on $BRANCH.
advance_code() {
  local dir=$1 new=$2
  [[ "$SKIP_PULL" == 1 ]] && return 0
  cd "$dir"
  if [[ "$(git rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]]; then
    note "switching $(basename "$dir") from $(git rev-parse --abbrev-ref HEAD) to $BRANCH"
    git checkout --quiet "$BRANCH"
  fi
  git merge --ff-only --quiet "$new"
}

step "2. Fetching origin/$BRANCH"
if (( DO_API )); then check_code "$API_DIR" "Server"; API_PREV=$CODE_PREV; API_NEW=$CODE_NEW; fi
if (( DO_WEB )); then
  check_code "$WEB_DIR" "Web"; WEB_PREV=$CODE_PREV; WEB_NEW=$CODE_NEW
  advance_code "$WEB_DIR" "$WEB_NEW"
fi

# Install packages only when package-lock.json changed since the last
# install here: an install deletes node_modules first, and the running
# API loads some modules only when they are first needed.
install_deps() {   # install_deps <dir> <name> <prev commit> <npm ci args…>
  local dir=$1 name=$2 prev=$3; shift 3
  cd "$dir"
  local want stamp="node_modules/.deploy-lock-hash"
  want="$(sha256sum package-lock.json | cut -d' ' -f1) $*"
  if [[ -d node_modules && -f "$stamp" && "$(cat "$stamp")" == "$want" ]]; then
    ok "$name: packages unchanged, not reinstalled"
    return 0
  fi
  # The first run of this script on a box finds packages installed by hand
  # and no stamp. When the lockfile did not change in this deploy and npm
  # finds nothing missing, those packages are kept rather than reinstalled.
  if [[ -d node_modules && ! -f "$stamp" ]] && git diff --quiet "$prev" HEAD -- package-lock.json \
     && npm ls --all "$@" >/dev/null 2>&1; then
    echo "$want" > "$stamp"
    ok "$name: packages already match the lockfile, not reinstalled"
    return 0
  fi
  note "$name: installing packages (npm ci $*)…"
  rm -f "$stamp"
  npm ci --no-audit --no-fund --loglevel=error "$@"
  # npm can stop part way and still exit 0 ("Exit handler never called!"),
  # leaving node_modules half filled. The install is only taken as done
  # when every package the lockfile names is there.
  if ! npm ls --all "$@" >/dev/null 2>&1; then
    npm ls --all "$@" 2>&1 | grep -E 'missing|invalid|ERR' | head -10 || true
    die "$name: the package install did not complete (above). Check the box can reach registry.npmjs.org, then run this again."
  fi
  echo "$want" > "$stamp"
  ok "$name: packages installed"
}

# ── 3. Build the web app and the portal (nothing live changes yet) ─
if (( DO_WEB )); then
  step "3. Building the web app and the portal"
  # Vite and TypeScript are dev packages: included even when the shell says NODE_ENV=production.
  install_deps "$WEB_DIR" "Web" "$WEB_PREV" --include=dev
  cd "$WEB_DIR"
  # The build lists every file it writes: that goes to the log, and to the
  # screen only when the build fails.
  build() {   # build <npm script> <out dir> <name>
    local out; out=$(mktemp)
    note "$3 (npm run $1: type-check, then build into $2/)…"
    if ! npm run --silent "$1" >"$out" 2>&1; then
      cat "$out" >> "$LOG"; tail -40 "$out"; rm -f "$out"
      die "The $3 build failed (above). Nothing live has changed."
    fi
    cat "$out" >> "$LOG"; rm -f "$out"
    [[ -s "$2/index.html" && -d "$2/assets" ]] || die "The $3 build finished without $2/index.html or $2/assets."
    ok "$3 built ($(du -sh "$2" | cut -f1))"
  }
  build build dist "Staff app"
  build build:portal dist-portal "Portal"
else
  step "3. Web build skipped ($WHAT only)"
fi

# ── 4. The API ────────────────────────────────────────────────────
if (( DO_API )); then
  step "4. Deploying the API"
  # The code moves only now, just before the restart.
  advance_code "$API_DIR" "$API_NEW"
  API_MOVED=1
  [[ "$API_PREV" == "$API_NEW" ]] || ok "Server code at ${API_NEW:0:7}"
  install_deps "$API_DIR" "Server" "$API_PREV" --omit=dev
  cd "$API_DIR"

  # Migrations are not run by the service (it starts node directly, not
  # npm start): this is the step deploy/API_DEPLOY.md says keeps being missed.
  # A status that cannot be read stops the deploy: it is not "nothing to run".
  migrate_status() {
    MIGRATE_OUT=$(node_modules/.bin/migrate-mongo status 2>&1) || {
      echo "$MIGRATE_OUT" | tail -20
      die "Could not read the migration status (above). Is MONGO_URL in config/.env right, and is this box allowed in Atlas → Network Access?"
    }
  }
  migrate_status
  pending=$(grep -c 'PENDING' <<<"$MIGRATE_OUT" || true)
  if (( pending > 0 )); then
    note "Running $pending database migration(s)…"
    grep 'PENDING' <<<"$MIGRATE_OUT" | sed 's/^/     /'
    npm run --silent migrate
    migrate_status
    left=$(grep -c 'PENDING' <<<"$MIGRATE_OUT" || true)
    (( left == 0 )) || die "$left migration(s) still pending after running them. See: npm run migrate:status"
    ok "$pending migration(s) applied"
  else
    ok "No migrations to run"
  fi

  note "Restarting $API_SERVICE…"
  sudo systemctl restart "$API_SERVICE"
  API_RESTARTED=1

  # Ready means the process answers AND it has the database.
  ready=0
  for _ in $(seq 1 $(( (READY_WAIT + 1) / 2 ))); do
    if curl -fsS -m 3 "http://127.0.0.1:$API_PORT/api/v2/health/ready" >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
  done
  if (( ready == 0 )); then
    echo
    echo "The API did not become ready within $READY_WAIT seconds. Its last log lines:"
    sudo journalctl -u "$API_SERVICE" -n 40 --no-pager || true
    echo
    if [[ -n "$API_PREV" && "$API_PREV" != "$API_NEW" ]]; then
      echo "To go back to the code that was running before (${API_PREV:0:7}):"
      echo "  git -C $API_DIR checkout --quiet $API_PREV && SKIP_PULL=1 $SELF api"
      echo "  (Migrations already applied stay applied; each one's 'down' is in migrations/ if one must be undone.)"
    fi
    die "The API is not ready after the restart."
  fi
  ok "API ready on 127.0.0.1:$API_PORT with the database connected"

  # Proxy and service files change rarely, and the copies in /etc may have
  # been edited on this box, so they are compared and pointed out, never overwritten.
  if [[ -f /etc/caddy/Caddyfile ]] && ! sudo cmp -s "$API_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile; then
    warn "deploy/Caddyfile differs from /etc/caddy/Caddyfile. Look: sudo diff /etc/caddy/Caddyfile $API_DIR/deploy/Caddyfile — to take it: sudo cp $API_DIR/deploy/Caddyfile /etc/caddy/Caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy"
  fi
  if [[ -n "$API_PREV" && "$API_PREV" != "$API_NEW" ]] && ! git diff --quiet "$API_PREV" "$API_NEW" -- deploy/jarvis.service; then
    warn "deploy/jarvis.service changed in this deploy. Compare it with /etc/systemd/system/$API_SERVICE.service, copy it if needed, then: sudo systemctl daemon-reload && sudo systemctl restart $API_SERVICE"
  fi
else
  step "4. API skipped ($WHAT only)"
fi

# ── 5. Publish the web builds ─────────────────────────────────────
publish() {   # publish <build dir> <served dir> <name>
  local src=$1 dst=$2 name=$3 owner
  if [[ -d "$dst" ]]; then
    owner=$(stat -c '%U:%G' "$dst")
  elif id caddy >/dev/null 2>&1; then owner=caddy:caddy
  elif id www-data >/dev/null 2>&1; then owner=www-data:www-data
  else owner=$(id -un):$(id -gn); fi
  sudo mkdir -p "$dst/assets"
  local rs=(sudo rsync -rlt "--chmod=D755,F644" "--chown=$owner")
  # 1. This build's hashed files, beside last build's (a tab still open on the old page keeps working).
  "${rs[@]}" "$src/assets/" "$dst/assets/"
  # 2. The page and the unhashed files beside it; files this build no longer has go.
  "${rs[@]}" --delete --exclude '/assets/' "$src/" "$dst/"
  # 3. Last build's hashed files go. A tab opened before the deploy asks
  #    for one, gets a 404, and the app reloads onto the new build
  #    (the Caddyfile's rule 2 is written for exactly this).
  "${rs[@]}" --delete "$src/assets/" "$dst/assets/"
  sudo cmp -s "$src/index.html" "$dst/index.html" || die "$name: $dst/index.html is not the one just built."
  ok "$name published to $dst (owner $owner)"
}

if (( DO_WEB )); then
  step "5. Publishing the web builds"
  publish "$WEB_DIR/dist" "$ERP_ROOT" "Staff app"
  WEB_PUBLISHED=1
  publish "$WEB_DIR/dist-portal" "$PORTAL_ROOT" "Portal"
else
  step "5. Web publish skipped ($WHAT only)"
fi

# ── 6. From the outside ───────────────────────────────────────────
check_url() {   # check_url <url> <name>
  local code
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$1" || true)
  if [[ "$code" == 200 ]]; then ok "$2: $1 → 200"; else warn "$2: $1 answered ${code:-nothing} (expected 200). DNS, the security group or Caddy: sudo journalctl -u caddy -n 50"; fi
}
same_page() {   # same_page <url> <built index.html> <name> — is the site serving what was just built?
  if curl -s -m 15 -H 'Cache-Control: no-cache' "$1/" | cmp -s - "$2"; then
    ok "$3: the site serves the page just built"
  else
    warn "$3: $1 does not serve the page just built. A CDN or proxy in front, or Caddy serving another folder."
  fi
}

if [[ "$SKIP_PUBLIC_CHECK" == 1 ]]; then
  step "6. Public checks skipped (SKIP_PUBLIC_CHECK=1)"
else
  step "6. Checking the public addresses"
  if (( DO_API )); then check_url "$API_URL/api/v2/health/ready" "API"; fi
  if (( DO_WEB )); then
    check_url "$ERP_URL/" "Staff app";  same_page "$ERP_URL" "$WEB_DIR/dist/index.html" "Staff app"
    check_url "$PORTAL_URL/" "Portal";  same_page "$PORTAL_URL" "$WEB_DIR/dist-portal/index.html" "Portal"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────
trap - ERR
STEP="done"
printf '\n\033[1m── Deployed in %ss\033[0m\n' "$(( $(date +%s) - STARTED ))"
show() {   # show <dir> <name> <prev> <new>
  local dir=$1 name=$2 prev=$3 new=$4
  [[ -n "$new" ]] || return 0
  if [[ "$prev" == "$new" ]]; then
    echo "  $name: ${new:0:7} (unchanged)"
  else
    echo "  $name: ${prev:0:7} → ${new:0:7}"
    git -C "$dir" log --format='      %h %s' "$prev..$new" | head -15
    local n; n=$(git -C "$dir" rev-list --count "$prev..$new")
    if (( n > 15 )); then echo "      … and $(( n - 15 )) more"; fi
  fi
}
show "$API_DIR" "Server" "$API_PREV" "$API_NEW"
show "$WEB_DIR" "Web" "$WEB_PREV" "$WEB_NEW"
if (( ${#WARNINGS[@]} )); then
  echo
  echo "  To look at:"
  for w in "${WARNINGS[@]}"; do echo "   ! $w"; done
fi
echo
echo "  Log: $LOG"
