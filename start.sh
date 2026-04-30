#!/bin/bash
# Start proxy with WX env loaded. Use this instead of `node server.mjs`.
set -a
[ -f ~/.hermes/local/wx-gateway-secrets.txt ] && . ~/.hermes/local/wx-gateway-secrets.txt
set +a
cd "$(dirname "$0")"
exec node server.mjs "$@"
