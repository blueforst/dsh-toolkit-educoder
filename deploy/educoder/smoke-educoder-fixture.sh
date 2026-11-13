#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

compose=(docker compose -f compose.yaml -f compose.educoder-fixture.yaml)
bootstrap=$("${compose[@]}" logs --no-color dsh |
  sed -nE 's#.*dsh web: http://127\.0\.0\.1:[0-9]+/\?token=([^[:space:]]+).*#\1#p' |
  tail -1)
if [[ ! "$bootstrap" =~ ^[A-Za-z0-9_-]+$ ]]; then
  printf '找不到有效的 DSH 开发实例启动凭据。\n' >&2
  exit 1
fi

smoke=fixtures/educoder-web-smoke.mjs
case "${1:-}" in
  '') ;;
  --browser) smoke=fixtures/educoder-client.test.mjs ;;
  --vision) smoke=fixtures/educoder-vision-smoke.mjs ;;
  *) printf '用法：%s [--browser | --vision]\n' "$0" >&2; exit 2 ;;
esac

{
  printf "process.env.DSH_EDUCODER_SMOKE_URL = 'http://127.0.0.1:3080/?token=%s';\n" "$bootstrap"
  printf "process.env.DSH_EDUCODER_PLAYWRIGHT = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/playwright-core/index.mjs';\n"
  cat "$smoke"
} | "${compose[@]}" exec -T dsh node --input-type=module
