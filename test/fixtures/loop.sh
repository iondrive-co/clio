#!/usr/bin/env bash

trap 'exit 130' INT

echo "RUNNING $$ ${1:-none}"
while true; do sleep 1; done
