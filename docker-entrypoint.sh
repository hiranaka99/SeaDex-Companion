#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = '0' ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi

exec "$@"
