#!/usr/bin/env bash
set -euo pipefail

tls_dir="${SYNAPSOR_FLEET_TLS_DIR:-/tmp/synapsor-runner-tls}"
mkdir -p "$tls_dir"
chmod 700 "$tls_dir"

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$tls_dir/server.key" \
  -out "$tls_dir/server.crt" \
  >/dev/null 2>&1
chmod 600 "$tls_dir/server.key" "$tls_dir/server.crt"

export SYNAPSOR_FLEET_TLS_CERT_PEM="$(<"$tls_dir/server.crt")"
export SYNAPSOR_FLEET_TLS_KEY_PEM="$(<"$tls_dir/server.key")"

exec node apps/runner/dist/cli.js "$@" \
  --tls-cert-env SYNAPSOR_FLEET_TLS_CERT_PEM \
  --tls-key-env SYNAPSOR_FLEET_TLS_KEY_PEM
