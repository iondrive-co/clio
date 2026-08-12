#!/usr/bin/env bash
# Launcher tests.
#
# These exist because starting the daemon was broken for anyone who followed
# the README and symlinked clio onto their PATH: the script worked out its own
# location without resolving the link, looked for the daemon one directory
# above ~/.local/bin, and silently failed to start it. Every command that
# found the daemon already running masked the bug.
set -uo pipefail

# Nothing in this file may reach the desktop it was started from. Later sections
# put real browser windows on screen, and dropping those over somebody's work is
# both rude and useless as a test: a window a person is clicking on, focusing or
# closing does not behave the way the assertions expect, and the failures that
# produces look exactly like bugs in clio.
#
# So the display goes here, before anything can inherit it, and comes back only
# as one this script made for itself in start_display below.
unset DISPLAY WAYLAND_DISPLAY

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
CLIO="$ROOT/bin/clio"
TMP="$(mktemp -d)"

# A clio of this test's own, from the first line to the last.
#
# Everything below drives the launcher for real — `clio stop`, and `clio start`
# after a SIGKILL. The daemon those act on is whichever one these two variables
# point at, so inheriting them means a test run reaching into the shells
# somebody is working in: their processes killed,
# their tabs rebuilt around new ones, and their daemon left running out of this
# checkout. That is not a thing a test may do, however carefully the sections
# further down isolate themselves.
export XDG_RUNTIME_DIR="$TMP/run" XDG_STATE_HOME="$TMP/state"
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_STATE_HOME"

XVFB_PID=""
WM_PID=""

stop_display() {
  [ -n "$WM_PID" ] && kill "$WM_PID" 2>/dev/null
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null
  WM_PID=""
  XVFB_PID=""
  unset DISPLAY
}

# A display of our own, with a window manager on it — wmctrl asks the window
# manager for the client list, so bare Xvfb would answer nothing at all.
#
# Returns 1 when the machine has no Xvfb or no window manager, and the window
# tests are then skipped. Falling back to whatever display is at hand is the one
# thing this must never do.
start_display() {
  command -v Xvfb >/dev/null 2>&1 || return 1

  local wm=""
  for candidate in openbox xfwm4 marco icewm fluxbox jwm metacity; do
    if command -v "$candidate" >/dev/null 2>&1; then wm="$candidate"; break; fi
  done
  [ -n "$wm" ] || return 1

  local n
  for n in $(seq 91 120); do
    [ -e "/tmp/.X${n}-lock" ] && continue

    Xvfb ":$n" -screen 0 1280x900x24 >/dev/null 2>&1 &
    XVFB_PID=$!
    sleep 1.5
    kill -0 "$XVFB_PID" 2>/dev/null || { XVFB_PID=""; continue; }

    export DISPLAY=":$n"
    "$wm" >/dev/null 2>&1 &
    WM_PID=$!
    sleep 1.5
    # Proof it is really there and answering, rather than a display number and
    # some hope.
    wmctrl -m >/dev/null 2>&1 && return 0

    stop_display
  done
  return 1
}

# The browser can still be letting go of its profile directory as this runs, so
# do not make a noisy failure out of tidying up.
trap 'stop_display; sleep 1; rm -rf "$TMP" 2>/dev/null || true' EXIT

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

# SIGKILL, so the daemon gets no chance to save on the way out: this is the
# power-cut path, not a clean stop. The restart still goes through the
# symlinked launcher, because finding the daemon entry point from a link on
# PATH is the thing that was broken and the thing under test here.
kill -9 "$before_pid" 2>/dev/null
sleep 1
"$LINKED" start >/dev/null 2>&1
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
if command -v wmctrl >/dev/null 2>&1 && start_display; then
  echo "  (on $DISPLAY, which this test started and will take down again)"
  # An isolated clio from here on: its own state, and so its own browser
  # profile. That profile is what makes these windows identifiable — a window
  # belongs to this test when the browser holding it was started with that
  # directory. Nothing else on the desktop is counted, let alone closed.
  export XDG_STATE_HOME="$TMP/win/state" XDG_RUNTIME_DIR="$TMP/win/run"
  mkdir -p "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR"
  PROFILE="$XDG_STATE_HOME/clio/browser-profile"

  ours() { # ids of the windows this test put on screen
    local id desktop pid rest
    while read -r id desktop pid rest; do
      [ -r "/proc/$pid/cmdline" ] || continue
      tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q -- "--user-data-dir=$PROFILE" && echo "$id"
    done < <(wmctrl -l -p)
  }
  on_screen() { ours | wc -l; }
  close_ours() { for id in $(ours); do wmctrl -i -c "$id"; done; sleep 2; }

  "$CLIO" >/dev/null 2>&1; rc=$?
  [ $rc -eq 0 ]; check "clio reports opening a window" $?
  sleep 2
  [ "$(on_screen)" -eq 1 ]; check "and one is really on screen" $?

  # A second window is a second set of tabs. Two windows onto the same shells
  # is the thing this must never do: a tab closed in one would disappear from
  # under the other, and typing would land in both.
  "$CLIO" >/dev/null 2>&1
  sleep 2
  [ "$(on_screen)" -eq 2 ]; check "running clio again opens another window" $?
  [ "$("$CLIO" status | grep -c '^  window ')" -eq 2 ]
  check "the daemon tracks them as two separate windows" $?

  echo
  echo "7. closing a window keeps its tabs"
  # Closing a window closes the window. The shells in it are the work, and they
  # go on running under a name until somebody opens them again — which is the
  # whole of what clio is for, applied to the case people actually hit.
  close_ours
  [ "$(on_screen)" -eq 0 ]; check "closing them leaves nothing on screen" $?
  sleep 13 # past the grace period the daemon allows for a page reloading
  [ "$("$CLIO" status | grep -c '^  window ')" -eq 2 ]
  check "both windows are still known to the daemon" $?
  [ "$("$CLIO" status | grep -c 'closed, its shells are still running')" -eq 2 ]
  check "as closed, with their shells still running" $?
  "$CLIO" windows | grep -q "Closed windows, still running"
  check "and clio windows lists them" $?

  # With windows waiting, `clio` is a question rather than an answer: one window
  # opens onto the picker instead of two windows opening themselves.
  "$CLIO" >/dev/null 2>&1; rc=$?
  [ $rc -eq 0 ]; check "clio still opens a window afterwards" $?
  sleep 3
  [ "$(on_screen)" -eq 1 ]; check "one window, to choose in — not the two just closed" $?
  [ "$("$CLIO" status | grep -c 'closed, its shells are still running')" -eq 2 ]
  check "and choosing nothing leaves both where they were" $?
  close_ours
  sleep 13

  echo
  echo "7b. windows come back from a daemon that died"
  # The loss clio does exist for, in the only order a reboot can happen in: the
  # daemon goes first, so nothing is left to hear the windows close.
  #
  # Both windows are put back by name first — the terminal's way into the same
  # picker — so that what is on screen when the daemon is killed is known.
  # Names can carry spaces, so they come out of the daemon one per line rather
  # than through word splitting.
  kept_names() {
    node -e '
      const fs = require("fs");
      const info = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      fetch(`http://127.0.0.1:${info.port}/status?token=${info.token}`)
        .then((r) => r.json())
        .then((s) => s.containers.filter((c) => c.saved).forEach((c) => console.log(c.name || c.id)));
    ' "$XDG_RUNTIME_DIR/clio/daemon.json"
  }

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    "$CLIO" open "$name" >/dev/null 2>&1
    sleep 2
  done < <(kept_names)
  [ "$(on_screen)" -eq 2 ]; check "two windows open again, by name" $?
  kill -9 "$(pid_now)" 2>/dev/null || true
  sleep 1
  close_ours

  "$CLIO" >/dev/null 2>&1; rc=$?
  [ $rc -eq 0 ]; check "clio starts the daemon again and reopens them" $?
  sleep 3
  [ "$(on_screen)" -eq 2 ]; check "both windows are back, not one" $?

  echo
  echo "8. a window outlives whatever launched it"
  close_ours
  # Run clio inside its own process group, then kill that whole group — the
  # same thing that happens when you close the terminal you typed clio in.
  # Without a session of its own, the browser goes down with it.
  setsid bash -c "'$CLIO' >/dev/null 2>&1" &
  group=$!
  sleep 10
  kill -TERM -"$group" 2>/dev/null || true
  kill -KILL -"$group" 2>/dev/null || true
  sleep 3
  [ "$(on_screen)" -ge 1 ]
  check "window survives its launching shell being killed" $?

  close_ours
  "$CLIO" stop >/dev/null 2>&1
  stop_display
else
  echo "  - skipped (needs wmctrl, Xvfb and a window manager; never the real display)"
fi

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
