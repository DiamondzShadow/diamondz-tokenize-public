#!/usr/bin/env bash
# Starts the API with secrets from ~/.diamondz-tokenize.env (mode 600, VM only — never commit it).
set -euo pipefail
cd "$(dirname "$0")"
set -a; source "${TOKENIZE_ENV:-$HOME/.diamondz-tokenize.env}"; set +a
export NODE_ENV=production
exec bun run src/server.ts
