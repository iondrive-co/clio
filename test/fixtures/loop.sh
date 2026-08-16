#!/usr/bin/env bash
# A stand-in for the thing somebody sets running in a tab and leaves running,
# for test/scripts.mjs.
#
# It says which run it is — the pid, so a restart can be told from a survivor,
# and whatever it was given, so a restart can be shown to have kept it — and
# then holds the terminal the way a watcher or a dashboard agent would.

# Ctrl-C ends it, which a bash loop does not do on its own: the interrupt kills
# whatever the loop is waiting on and the loop goes round again. Section 6 is
# somebody stopping this on purpose, and it has to actually stop.
trap 'exit 130' INT

echo "RUNNING $$ ${1:-none}"
while true; do sleep 1; done
