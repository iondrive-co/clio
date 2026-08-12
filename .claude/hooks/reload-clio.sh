#!/usr/bin/env bash
#
# Never leave the daemon older than the tree it is running from.
#
# A daemon runs the code it was started with and nothing changes that but a
# reload. An agent that edits src/ and walks away leaves one that will go on
# behaving like yesterday's clio for as long as it is up — which is not a
# hypothetical: an extension was written, committed, and then did nothing at all
# for two hours, because the daemon holding the shells had been started before
# it existed. When that daemon finally died it took five conversations with it
# and could not name one of them.
#
# So this runs when an agent stops. It reloads, which is the whole point:
# a handover moves every shell across as an open file descriptor, so nothing in
# a tab is restarted, reconnected or told anything happened, and the windows
# come back on the new code by themselves. It never stops and starts the daemon
# — that ends every shell on the machine, and an agent does not get to make that
# choice on somebody's behalf.
#
# It acts on whatever XDG_RUNTIME_DIR points at, so an agent working in a
# sandbox reloads its own sandbox and nobody else's.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HANDSHAKE="${XDG_RUNTIME_DIR:-$HOME/.cache}/clio/daemon.json"

[ -f "$HANDSHAKE" ] || exit 0

read -r pid started < <(
  node -e '
    try {
      const i = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (i.pid && i.startedAt) console.log(i.pid, i.startedAt);
    } catch {}
  ' "$HANDSHAKE"
) || exit 0

[ -n "${pid:-}" ] && [ -n "${started:-}" ] || exit 0
kill -0 "$pid" 2>/dev/null || exit 0   # a handshake left behind by a dead daemon

# Is the tree newer than the daemon reading it? If not there is nothing to pick
# up, and a reload would only blink somebody's windows for no reason.
newer="$(find "$ROOT/src" -type f -newermt "@$((started / 1000))" -print -quit 2>/dev/null)"
[ -n "$newer" ] || exit 0

# Half-written code that happens to start is worse than stale code. The reload
# already fails safe — a successor that will not start hands the shells back —
# but there is no sense asking for that on purpose.
while IFS= read -r file; do
  if ! node --check "$file" >/dev/null 2>&1; then
    echo "clio: not reloading — $file does not parse. The daemon is still running the old code." >&2
    exit 0
  fi
done < <(find "$ROOT/src" -name '*.js' -type f)

echo "clio: src changed since the daemon started; reloading it (shells are kept)."
"$ROOT/bin/clio" reload
