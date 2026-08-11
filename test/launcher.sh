#!/usr/bin/env bash
# Launcher tests.
#
# These exist because `clio crash` was broken for anyone who followed the
# README and symlinked clio onto their PATH: the script worked out its own
# location without resolving the link, looked for the daemon one directory
# above ~/.local/bin, and silently failed to restart it. Every command that
# found the daemon already running masked the bug.
set -uo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
CLIO="$ROOT/bin/clio"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

passed=0
failed=0

check() { # check <label> <condition-exit-code>
  if [ "$2" -eq 0 ]; then
    passed=$((passed + 1)); echo "  ✓ $1"
  else
    failed=$((failed + 1)); echo "  ✗ $1"
  fi
}

port_now() {
  node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.env.XDG_RUNTIME_DIR+"/clio/daemon.json","utf8")).port)}catch{console.log("none")}'
}
pid_now() {
  node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.env.XDG_RUNTIME_DIR+"/clio/daemon.json","utf8")).pid)}catch{console.log("none")}'
}

echo "1. running through a symlink on PATH"
mkdir -p "$TMP/bin"
ln -s "$CLIO" "$TMP/bin/clio"
LINKED="$TMP/bin/clio"

"$CLIO" stop >/dev/null 2>&1; sleep 1

"$LINKED" start >/dev/null 2>&1
sleep 1.5
[ "$(pid_now)" != "none" ]; check "the symlinked launcher starts the daemon" $?

"$LINKED" status >/dev/null 2>&1; check "status works through the symlink" $?

echo
echo "2. crash and restart, through the symlink"
before_pid="$(pid_now)"
before_port="$(port_now)"

"$LINKED" crash >/dev/null 2>&1
sleep 2
after_pid="$(pid_now)"
after_port="$(port_now)"

[ "$after_pid" != "none" ]; check "the daemon came back after crash" $?
[ "$after_pid" != "$before_pid" ]; check "it is genuinely a new process" $?
# The port must not move, or windows left open can never find it again.
[ "$after_port" = "$before_port" ]; check "it reclaimed the same port ($before_port)" $?

# The daemon has to be answering, not merely have a pid recorded.
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$after_port/auth" 2>/dev/null)"
[ "$code" = "403" ] || [ "$code" = "204" ]; check "it is actually serving (HTTP $code)" $?

echo
echo "3. a broken install fails loudly instead of silently"
mkdir -p "$TMP/fake/bin"
cp "$CLIO" "$TMP/fake/bin/clio"
out="$("$TMP/fake/bin/clio" start 2>&1)"; rc=$?
[ $rc -ne 0 ]; check "exits non-zero when the daemon is missing" $?
grep -q "cannot find the daemon" <<<"$out"; check "says what it could not find" $?

echo
echo "4. a fresh copy needs only the one documented command"
FRESH="$TMP/fresh"
mkdir -p "$FRESH"
(cd "$ROOT" && tar --exclude=node_modules --exclude=test/screenshots --exclude=.git -cf - .) \
  | (cd "$FRESH" && tar -xf -)
[ ! -d "$FRESH/node_modules" ]; check "the copy has no dependencies installed" $?

"$CLIO" stop >/dev/null 2>&1; sleep 1
XDG_STATE_HOME="$FRESH/state" XDG_RUNTIME_DIR="$FRESH/run" \
  "$FRESH/bin/clio" start >/dev/null 2>&1
sleep 1
fresh_pid="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid)}catch{console.log("none")}' "$FRESH/run/clio/daemon.json")"
[ "$fresh_pid" != "none" ]; check "it installed its own deps and started" $?
[ -d "$FRESH/node_modules/node-pty" ]; check "dependencies were fetched" $?
XDG_STATE_HOME="$FRESH/state" XDG_RUNTIME_DIR="$FRESH/run" \
  "$FRESH/bin/clio" stop >/dev/null 2>&1
sleep 1

echo
echo "5. desktop integration"
DESKTOP_HOME="$TMP/home"
mkdir -p "$DESKTOP_HOME"
HOME="$DESKTOP_HOME" "$LINKED" install >/dev/null 2>&1
[ -f "$DESKTOP_HOME/.local/share/applications/clio.desktop" ]; check "writes a .desktop entry" $?
grep -q '^StartupWMClass=clio$' "$DESKTOP_HOME/.local/share/applications/clio.desktop"
check "matches the window by WM_CLASS, so the panel finds its icon" $?
grep -q "^Exec=$CLIO\$" "$DESKTOP_HOME/.local/share/applications/clio.desktop"
check "Exec points at the real launcher, not the symlink" $?
[ -f "$DESKTOP_HOME/.local/share/icons/hicolor/256x256/apps/clio.png" ]
check "installs a full-size panel icon" $?
[ -L "$DESKTOP_HOME/.local/bin/clio" ]; check "puts clio on PATH" $?

# the icon the browser uses for the window/taskbar must actually be served
"$CLIO" start >/dev/null 2>&1; sleep 1.5
p="$(port_now)"
ctype="$(curl -s -o /dev/null -w '%{content_type}' "http://127.0.0.1:$p/icon.png")"
[ "$ctype" = "image/png" ]; check "serves /icon.png as a PNG" $?
size="$(curl -s "http://127.0.0.1:$p/icon.png" | wc -c)"
[ "$size" -gt 1000 ]; check "the icon is a real image ($size bytes)" $?
grep -q 'rel="icon"' "$ROOT/src/ui/index.html"; check "the page declares it as its favicon" $?

echo
echo "6. opening a window is confirmed, not assumed"
if [ -n "${DISPLAY:-}" ] && command -v wmctrl >/dev/null 2>&1; then
  "$CLIO" start >/dev/null 2>&1; sleep 1
  # Close any existing window, then reopen immediately — the browser may still
  # be releasing its profile lock, which used to fail silently.
  for id in $(wmctrl -l | grep -i clio | awk '{print $1}'); do wmctrl -i -c "$id"; done
  sleep 1
  "$CLIO" open >/dev/null 2>&1; rc=$?
  [ $rc -eq 0 ]; check "reopening straight after closing succeeds" $?
  sleep 2
  [ -n "$(wmctrl -l | grep -i clio)" ]; check "a window is really on screen" $?
  for id in $(wmctrl -l | grep -i clio | awk '{print $1}'); do wmctrl -i -c "$id"; done
  sleep 1

  echo
  echo "7. the window outlives whatever launched it"
  # Run clio inside its own process group, then kill that whole group — the
  # same thing that happens when you close the terminal you typed clio in.
  # Without setsid on the browser, this took the terminal window down with it.
  setsid bash -c "'$CLIO' open >/dev/null 2>&1" &
  group=$!
  sleep 6
  kill -TERM -"$group" 2>/dev/null || true
  kill -KILL -"$group" 2>/dev/null || true
  sleep 3
  [ -n "$(wmctrl -l | grep -i clio)" ]
  check "window survives its launching shell being killed" $?
  for id in $(wmctrl -l | grep -i clio | awk '{print $1}'); do wmctrl -i -c "$id"; done
else
  echo "  - skipped (no DISPLAY or wmctrl)"
fi

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
