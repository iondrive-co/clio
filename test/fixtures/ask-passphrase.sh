#!/bin/sh
LOCK="$HOME/agent-has-the-key"
ANSWERS="$HOME/answers"

if [ -f "$LOCK" ]; then
  echo '# the key is already in the agent'
  exit 0
fi

printf 'Enter passphrase for %s/.ssh/id_rsa: ' "$HOME" > /dev/tty
read answer < /dev/tty
echo "$answer" >> "$ANSWERS"

if [ "$answer" = "open-sesame" ]; then
  : > "$LOCK"
  echo '# identity added'
else
  echo '# bad passphrase' > /dev/tty
fi
