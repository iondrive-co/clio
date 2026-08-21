#!/bin/sh
# A bastion that wants a verification code, with no bastion anywhere near it.
#
# Handed to ssh as its ProxyCommand, so it runs in the tab's own terminal with
# the tab's own ssh waiting on it — which is where the real thing asks from too:
# `ssh pf4` through a jump host asks for the jump host's code before the tab has
# been anywhere. The question goes to /dev/tty rather than to stdout, because
# stdout is the pipe ssh is waiting to hear a banner down.
#
# Then it waits, the way something waiting for a person does, and once it has
# been answered it holds the connection open without ever making one — the same
# stand-in `-o ProxyCommand=sleep 900` is elsewhere in test/ssh.mjs.
printf 'Verification code: ' > /dev/tty
read code < /dev/tty
exec sleep 900
