#!/bin/sh
# A stand-in for keychain, for test/profile.mjs — and the shape is the whole
# point of it.
#
# It is run from a .bashrc as `eval "$(ask-passphrase.sh)"`, which is how
# keychain is run on a real desktop, and that shape is what makes a restore
# hard. It is a *child* of the shell, so it is not the shell that is busy; its
# stdout is a pipe, so the question cannot go there; and it asks on /dev/tty and
# then waits, for as long as it takes, in a terminal that clio is about to type
# a resume command into.
#
# It asks once per machine, not once per tab. A key goes into an agent and every
# shell after that finds it there — which is the whole reason a restore holds
# its tabs back behind the first one, and the thing this fixture exists to let a
# test check.
LOCK="$HOME/agent-has-the-key"
ANSWERS="$HOME/answers"

if [ -f "$LOCK" ]; then
  echo '# the key is already in the agent'
  exit 0
fi

printf 'Enter passphrase for %s/.ssh/id_rsa: ' "$HOME" > /dev/tty
read answer < /dev/tty
# Everything this was ever told, so that a test can say what was offered to it.
# On 24 August what a real one was offered was `bash scripts/ainun-dashboard-agent.sh`.
echo "$answer" >> "$ANSWERS"

if [ "$answer" = "open-sesame" ]; then
  : > "$LOCK"
  echo '# identity added'
else
  echo '# bad passphrase' > /dev/tty
fi
