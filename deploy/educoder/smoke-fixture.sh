#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

compose=(docker compose -f compose.yaml -f compose.fixture.yaml)
bootstrap=$("${compose[@]}" logs --no-color dsh |
  sed -nE 's#.*dsh web: http://127\.0\.0\.1:[0-9]+/\?token=([^[:space:]]+).*#\1#p' |
  tail -1)
if [[ ! "$bootstrap" =~ ^[A-Za-z0-9_-]+$ ]]; then
  printf '找不到有效的 DSH 开发实例启动凭据。\n' >&2
  exit 1
fi

{
  printf "process.env.TOOLKIT_TEST_URL = 'http://127.0.0.1:3080/?token=%s';\n" "$bootstrap"
  sed "s#from 'playwright-core'#from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/playwright-core/index.mjs'#" fixtures/web-integration.mjs
} | "${compose[@]}" exec -T dsh node --input-type=module
