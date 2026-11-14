# DSH EduCoder（`@forst/dsh-educoder`）

本仓库以 **`@forst/dsh-educoder`（当前 `0.2.10`）** 为核心，面向 DeepSeek Host（DSH）提供头歌（EduCoder）多账号管理、课程与实训作业队列调度、工作区可自愈 CLI，以及按工作区隔离注入的全账号视图与原生 Skill 工作流。仓库基于 [blueforst/dsh-toolkit](https://github.com/blueforst/dsh-toolkit) 派生维护，保留原服务器资源、OpenCode Go 额度/Pi 会话费用等辅助插件（见文末简述）。

- 详细文档：[EduCoder 插件说明](plugins/educoder/README.md) · [开发与公网部署](deploy/educoder/README.md) · [凭据隔离边界](deploy/educoder/凭据隔离.md) · [版本记录](CHANGELOG.md)
- 实测与构建：[EduCoder 验收记录](deploy/educoder/验收记录.md) · [作业准确率实测](deploy/educoder/作业准确率实测.md) · [Actions](https://github.com/blueforst/dsh-toolkit-educoder/actions) · [PR #1](https://github.com/blueforst/dsh-toolkit-educoder/pull/1)

## EduCoder 核心能力

- **多账号控制面与持久化队列**：通过 `accounts.sqlite` / `queue.sqlite` 与 DSH 本地凭据服务分账户管理登录态（不存原始密码），支持课程与实训作业浏览、单题分配及课程「一键通关」；已通过与客观题「待评审」（`pending_review`）均计入完成进度并自动跳过，任务队列默认按更新时间倒序展示。
- **DSH 原生 `SessionController` 常驻会话**：作业会话直接由 `SessionController` 创建与 24 小时内复用，统一挂载在「EduCoder」共享工作区；回合完成后回到 `idle` 留在会话栏供继续查看或追问，不在宿主挂载全局 `tools.guard`（普通会话完整保留 DSH 原生能力），仅在自动做题回合内于 `agentCtx.tools` 限定开放原生编码工具（`bash`/`pwsh`、`read`、`read_image`、`write`、`edit`、`glob`、`grep`、`job_*`），并在 `workspace-write` + `never` 下运行。
- **按工作区隔离注入全账号与原生 Skill**：
  - 仅在「EduCoder」共享工作区及 EduCoder Worker 会话内，通过内存 `ctx.shellEnv` 注入实时全账号快照 `DSH_EDUCODER_ACCOUNTS` 与共享 CLI 环境变量（不暴露宿主机模型密钥，不写明文凭据到磁盘；非 EduCoder 工作区普通对话完全隔离返回 `{}`）。
  - 工作区初始化时自动同步 [.dsh/skills/educoder-cli/SKILL.md](plugins/educoder/skills/educoder-cli/SKILL.md)，由 DSH 原生 `ctx.skills` 发现并指引模型用法，无需在系统或任务提示词中额外堆砌多账号提示。
  - 自动 Worker 回合仍默认锁定当前任务 `DSH_EDUCODER_SESSION` 与 `DSH_EDUCODER_TARGET`；工作区普通对话与显式 `--account` 可按需切换账号，并对输出、报错与日志执行全账号 Cookie 脱敏。
- **工作区可自愈 CLI（`./cli/educoder.mjs`）**：
  - 账号与目录：`accounts`（不输出原始 Cookie）、`courses`、`homeworks`、`--account <id|remoteUserId|label>`（支持单可用账号自动选中，切号/切题时清理旧关卡 `binding`）。
  - 解题与评测：`inspect`（支持省略 `--task-id` 自动解析当前/首关及 `--no-open`）、`read-file`、`save-file`、`evaluate`、`submit-choices`、`terminal`、`browser`、`images`；配合 `.educoder-cli-state.json` 保存证据读回与多图附件查看（最多内联 16 张参考图）。
  - 自检与补丁保留：`doctor`、`cli-diff`、`cli-restore` 与 `./cli/.baseline/` 基线快照，支持 Agent 或运维原地修复 `./cli/` 并在后续插件升级时自动保留已改源码。
- **部署与转发配套**：提供隔离验收与公网 Compose 配方，以及 [EduCoder 私网连接转发](deploy/educoder/educoder-connect/README.md)、[OpenCode Go 模型转发](deploy/educoder/go-model-relay/README.md)、[OpenCode Go 额度转发](deploy/educoder/go-quota-relay/README.md)。

## 快速安装与升级

环境要求：Node.js `>=24.9`，已验证 DSH `0.2.2-alpha.2`。

```bash
npm pack ./plugins/educoder --pack-destination dist
dsh plugin --profile web add --ignore-scripts --save-exact "$PWD/dist/forst-dsh-educoder-0.2.10.tgz"
```

卸载插件：

```bash
dsh plugin --profile web remove @forst/dsh-educoder
```

容器部署、凭据边界配置、模型与代理环境变量见 [deploy/educoder/README.md](deploy/educoder/README.md)。

## 开发检查与打包

```bash
npm run build
npm run check
DSH_ENTRYPOINT="$(realpath "$(which dsh)")" npm test
node tests/educoder-soak.mjs --duration-ms 4000
python3 -m unittest deploy/educoder/go-model-relay/test_relay.py
python3 scripts/audit-release.py
npm pack ./plugins/educoder --pack-destination dist
```

## 其他附带组件（原 DSH Toolkit）

仓库根包 `@forst/dsh-toolkit` 仍保留并可用于同一 `web` profile，仅作辅助监控与桌面/浏览器运行时配方提供（详细见对应目录文档）：

| 组件 | 用途简述 | 详细说明 |
| --- | --- | --- |
| 服务器资源 / OpenCode Go 额度 / Pi 费用 | 侧栏 CPU/内存/硬盘条、OpenCode Go 月额度读取、基于当前 Pi 目录的会话估算费用 | [部署说明](docs/部署说明.md) · [费用说明](docs/费用说明.md) · [插件清单](docs/插件清单.md) |
| Camoufox / Linux 桌面配方 | 可选 Docker 指纹浏览器运行时，以及基于 Cua Driver `0.28.0` 的 Xfce 桌面扩展镜像 | [Camoufox](integrations/camoufox/README.md) · [Linux 桌面](integrations/linux-desktop/README.md) |
| 本地通用版快照复用 | 从 `blueforst/dsh-toolkit-local` 固定提交生成的白名单 `vendor` 快照（Go 额度与 Pi 费用） | [拆分与版本复用](docs/拆分与版本复用.md) |

## 授权

自编插件和接入脚本按 MIT 授权；第三方运行时与上游组件保留各自授权，详见 [NOTICE.md](NOTICE.md)。
