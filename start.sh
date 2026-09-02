#!/usr/bin/env bash

set -euo pipefail

RUNTIME_PORT="${CLOUDSTREAM_RUNTIME_PORT:-10001}"

RUNTIME_URL="${CLOUDSTREAM_RUNTIME_JAR_URL:-https://raw.githubusercontent.com/star884/Mediav2/builds/runtime/mediav2-runtime.jar}"

RUNTIME_DIR="/tmp/mediav2-runtime"
RUNTIME_JAR="${RUNTIME_DIR}/mediav2-runtime.jar"

mkdir -p "$RUNTIME_DIR"

echo "========================================"
echo "Mediav2 startup"
echo "========================================"

echo "Downloading latest CloudStream runtime..."

curl \
  --fail \
  --location \
  --retry 5 \
  --retry-delay 3 \
  --connect-timeout 20 \
  --max-time 300 \
  -o "$RUNTIME_JAR" \
  "$RUNTIME_URL"

test -s "$RUNTIME_JAR"

echo "CloudStream runtime downloaded:"
ls -lh "$RUNTIME_JAR"

export CLOUDSTREAM_RUNTIME_PORT="$RUNTIME_PORT"

if [ -z "${CLOUDSTREAM_BRIDGE_URL:-}" ]; then
    export CLOUDSTREAM_BRIDGE_URL="http://127.0.0.1:${RUNTIME_PORT}"
fi

echo "Starting CloudStream JVM runtime..."

java \
  -Xms256m \
  -Xmx768m \
  -jar "$RUNTIME_JAR" &

RUNTIME_PID=$!

cleanup() {
    echo "Stopping CloudStream runtime..."
    kill "$RUNTIME_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

echo "Waiting for CloudStream runtime..."

READY=0

for i in $(seq 1 180); do
    if curl \
        --silent \
        --fail \
        --max-time 3 \
        "http://127.0.0.1:${RUNTIME_PORT}/health" \
        > /tmp/mediav2-runtime-health.json
    then
        READY=1
        break
    fi

    if ! kill -0 "$RUNTIME_PID" 2>/dev/null; then
        echo "CloudStream runtime exited unexpectedly."
        exit 1
    fi

    sleep 1
done

if [ "$READY" != "1" ]; then
    echo "CloudStream runtime failed to become ready."

    if [ -f /tmp/mediav2-runtime-health.json ]; then
        cat /tmp/mediav2-runtime-health.json
    fi

    exit 1
fi

echo "CloudStream runtime is READY."

cat /tmp/mediav2-runtime-health.json || true

echo "========================================"
echo "Starting Mediav2 Node server"
echo "Bridge: $CLOUDSTREAM_BRIDGE_URL"
echo "========================================"

exec node server.js
