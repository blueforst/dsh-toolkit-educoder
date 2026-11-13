// 保护在同一 Host 上的 DSH 凭据存储。插件挂载在受控部署补丁中。
export const name = 'educoder-credential-boundary';
export const inject = ['webServer', 'connection'];

const disabledFileUploads = Object.freeze({
  registerAgentResolver() { return () => {}; },
  resolve() { return undefined; },
  bindPrompt(_agent, receiptIds) {
    if (receiptIds.length) throw new Error('此实例未启用文件上传。');
    return { commit() {}, [Symbol.dispose]() {} };
  },
  retirePrompt() {},
});

const forbidden = [
  'terminalController', 'workspaceFiles', 'pluginManager',
  'configEditor', 'settingsController', 'credentialsController', 'accountController',
  'dynamicCordisRunner', 'cordisInspect', 'directoryPickerController', 'workspaceChanges',
  'cuaAccess', 'ptcRuntime',
];

const deniedRoutes = [
  '/api/file',
  '/api/session/uploadFileBinary',
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
  // Session 控制器依赖 fileUploads 来处理提示中的可选附件回执。
  // 此提供器只允许空回执的文本提示，不提供上传方法或 Remote 路由。
  ctx.provide('fileUploads', disabledFileUploads);
  // 运行时每次使用前重新核对。独立部署的 Host 本身仍是可信管理员边界。
  ctx.provide('educoderCredentialBoundary', () => {
    const uploads = ctx.get('fileUploads');
    return uploads !== undefined && typeof uploads.upload !== 'function' &&
      typeof uploads.uploadStream !== 'function' &&
      forbidden.every(key => ctx.get(key, false) === undefined);
  });
}
