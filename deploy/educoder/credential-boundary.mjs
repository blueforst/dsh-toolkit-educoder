// 保护在同一 Host 上的 DSH 凭据存储。插件挂载在受控部署补丁中。
export const name = 'educoder-credential-boundary';
export const inject = ['webServer', 'connection'];

const unavailableDirectory = Object.freeze({ kind: 'unavailable' });
const disabledDirectoryPicker = Object.freeze({
  capability() { return unavailableDirectory; },
});

const forbidden = [
  'terminalController', 'workspaceFiles', 'pluginManager',
  'accountController',
  'dynamicCordisRunner', 'cordisInspect', 'workspaceChanges',
  'cuaAccess', 'ptcRuntime',
];
const settingsServices = ['configEditor', 'settingsController', 'credentialsController'];

const deniedRoutes = [
  '/api/file',
  '/api/session/uploadFileBinary',
  '/api/fileUploads/upload',
  '/api/commands/execute',
  '/api/agentPresets/select',
  // 恢复原生设置浏览时，仍在入口拒绝写入、打开文件和模型探测。
  ...['mutate', 'replace', 'update', 'openSettingsDocument'].map(action => '/api/settings/' + action),
  '/api/credentials/set',
  '/api/credentials/unset',
  '/api/llm/discoverModels',
  ...['pick', 'list', 'createDirectory'].map(action => '/api/directoryPicker/' + action),
  ...[
    'create', 'fork', 'prompt', 'updateQueue', 'selectModel', 'initializeDefaultModel',
    'cancel', 'rename', 'openWorkspacePath', 'workspacePathApplications',
  ].map(action => '/api/session/' + action),
  ...['archiveSession', 'unarchiveSession'].map(action => '/api/workspace/' + action),
];

export function apply(ctx) {
  // session-controller 在 Connection 的 /api 前缀内挂载无路径限制的读取接口。
  // WebServer 的 exact 路由先于该前缀分派，保留 Session 控制器其余功能。
  for (const path of deniedRoutes) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler(req, res) {
        res.writeHead(ctx.connection.requestRejection(req) ?? 403, {
          'Cache-Control': 'no-store',
        });
        res.end();
      },
    }));
  }
  // DSH 的工作区导航依赖目录选择的 Remote 命名空间。空后端不访问文件系统。
  ctx.provide('directoryPicker', disabledDirectoryPicker);
  // 运行时每次使用前重新核对。独立部署的 Host 本身仍是可信管理员边界。
  ctx.provide('educoderCredentialBoundary', () => {
    const readonlySettings = process.env.DSH_EDUCODER_READONLY_SETTINGS === '1';
    return ctx.get('directoryPicker')?.capability()?.kind === 'unavailable' &&
      forbidden.every(key => ctx.get(key, false) === undefined) &&
      settingsServices.every(key => (ctx.get(key, false) !== undefined) === readonlySettings);
  });
}
