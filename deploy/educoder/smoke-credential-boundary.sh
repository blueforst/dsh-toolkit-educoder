#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  cd -- "$(dirname -- "$0")"
  set -- docker compose -f compose.yaml -f compose.educoder-fixture.yaml
fi

bootstrap=$("$@" logs --no-color dsh |
  sed -nE 's#.*dsh web: http://127\.0\.0\.1:[0-9]+/\?token=([A-Za-z0-9_-]+).*#\1#p' |
  tail -1)
if [[ ! "$bootstrap" =~ ^[A-Za-z0-9_-]+$ ]]; then
  printf '无法从专用实例取得启动凭据。\n' >&2
  exit 1
fi

{
  printf "const bootstrap = '%s';\n" "$bootstrap"
  cat <<'JS'
const origin = 'http://127.0.0.1:3080';
const timeout = () => AbortSignal.timeout(6_000);
let stage = 'bootstrap';
async function fetchChecked(path, options = {}) {
  return fetch(origin + path, { redirect: 'manual', signal: timeout(), ...options });
}
function status(name, response, expected) {
  stage = name;
  if (response.status !== expected) throw new Error('unexpected status ' + response.status);
  console.log(name, response.status);
}

try {
  const init = await fetchChecked('/?token=' + bootstrap);
  const cookie = init.headers.getSetCookie().map(item => item.split(';', 1)[0]).join('; ');
  await init.body?.cancel();
  if (!cookie) throw new Error('no auth cookie');
  const authenticated = { cookie, origin };
  for (const [name, path, method, headers, expected] of [
    ['web', '/', 'GET', authenticated, 200],
    ['anonymous-file', '/api/file?path=/etc/passwd', 'GET', {}, 401],
    ['authenticated-file', '/api/file?path=/etc/passwd', 'GET', authenticated, 403],
    ['file-head', '/api/file?path=/etc/passwd', 'HEAD', authenticated, 403],
    ['file-dot-segment', '/api/%2e/file?path=/etc/passwd', 'GET', authenticated, 403],
    ['cross-origin-file', '/api/file?path=/etc/passwd', 'GET', { cookie, origin: 'https://outside.invalid' }, 403],
    ['streaming-upload', '/api/session/uploadFileBinary', 'POST', authenticated, 403],
    ['encoded-upload', '/api/fileUploads/upload', 'POST', authenticated, 403],
    ['directory-list', '/api/directoryPicker/list', 'POST', authenticated, 403],
    ['directory-choose', '/api/directoryPicker/pick', 'POST', authenticated, 403],
    ['directory-create', '/api/directoryPicker/createDirectory', 'POST', authenticated, 403],
    ['native-path-open', '/api/session/openWorkspacePath', 'POST', authenticated, 403],
    ['manual-session', '/api/session/create', 'POST', authenticated, 403],
    ['manual-prompt', '/api/session/prompt', 'POST', authenticated, 403],
    ['manual-cancel', '/api/session/cancel', 'POST', authenticated, 403],
  ]) {
    stage = name;
    const response = await fetchChecked(path, { method, headers });
    status(name, response, expected);
    await response.body?.cancel();
  }

  async function rpc(endpoint, args) {
    stage = endpoint;
    return fetchChecked('/api/' + endpoint, {
      method: 'POST',
      headers: { ...authenticated, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args },
      }),
    });
  }
  const sessions = await rpc('session/list', { _request: {} });
  status('session-history-api', sessions, 200);
  if (!(await sessions.json()).result?.ok) throw new Error('session list refused');
  const catalog = await rpc('session/modelCatalog', {});
  status('model-catalog-api', catalog, 200);
  if (!(await catalog.json()).result?.ok) throw new Error('model catalog refused');

  for (const endpoint of [
    'credentials/describe', 'settings/describe', 'workspaceFiles/read', 'terminal/list',
  ]) {
    const response = await rpc(endpoint, {});
    const code = response.status === 200 ? (await response.json()).result?.error?.code : undefined;
    if (response.status !== 200) await response.body?.cancel();
    if (response.status !== 404 && code !== 'gateway/service-unavailable' &&
        code !== 'gateway/method-not-found' && code !== 'gateway/descriptor-not-found') {
      throw new Error('capability route is not absent');
    }
    console.log(endpoint, response.status);
  }
} catch {
  console.error('凭据边界验收失败', stage);
  process.exitCode = 1;
}
JS
} | "$@" exec -T dsh node --input-type=module
