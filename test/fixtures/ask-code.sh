#!/bin/sh
printf 'Verification code: ' > /dev/tty
read code < /dev/tty
exec sleep 900
