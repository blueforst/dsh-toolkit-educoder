# DSH Toolkit & EduCoder · Linux 服务器版

本仓库是 [blueforst/dsh-toolkit](https://github.com/blueforst/dsh-toolkit) 的独立派生项目，保留上游提交历史、许可证和原 Toolkit 软件包，并在此基础上新增 **`@forst/dsh-educoder`（当前 `0.2.0`）** 可选插件及隔离部署方案，提供头歌（EduCoder）多账号隔离、课程和作业选择、持久化任务队列以及基于 DSH 原生编码工具与工作区可自愈 CLI（`./cli/educoder.mjs`）的评测工作流。详细功能见 [EduCoder 插件说明](plugins/educoder/README.md)，安装与隔离验收见 [EduCoder 开发与公网部署](deploy/educoder/README.md)。

原 Toolkit 面向 Linux 服务器的 DSH 插件包：**服务器资源、OpenCode Go 月额度、Pi 会话费用**。另附 **Camoufox 指纹浏览器运行时**、**Linux 完整桌面与 Computer Use**及 **OpenCode Go 模型配置示例**。

从 **0.2.0** 起，本机通用功能已分离到 [dsh-toolkit-local](https://github.com/blueforst/dsh-toolkit-local)。个人电脑只需要额度与费用增强时，安装本机版即可；浏览器和 CUA 使用 DSH 原生能力。

本仓库保留服务器资源监控和部署配方，额度及费用从本机仓库的固定提交生成 `vendor` 快照，随服务器成品打包。两边只维护一份通用实现，服务器用户仍只需安装一个包。不要在同一 profile 同时安装服务器版和本机版。维护方式见 [拆分与版本复用](docs/拆分与版本复用.md)。

本仓库构建产物：[Actions](https://github.com/blueforst/dsh-toolkit-educoder/actions) · [PR #1](https://github.com/blueforst/dsh-toolkit-educoder/pull/1) · 上游基线：[blueforst/dsh-toolkit](https://github.com/blueforst/dsh-toolkit) · [上游 Releases](https://github.com/blueforst/dsh-toolkit/releases)

[定制组件清单](docs/插件清单.md) · [Toolkit 验收记录](docs/验收记录.md) · [EduCoder 验收记录](deploy/educoder/验收记录.md) · [EduCoder 作业准确率实测](deploy/educoder/作业准确率实测.md)

Linux 桌面新增配方及真实截图坐标验收见 [桌面说明](integrations/linux-desktop/README.md) 与 [桌面验收记录](docs/Linux桌面验收.md)。

## EduCoder 扩展（`@forst/dsh-educoder`）

- **多账号隔离与控制面**：每个头歌账号独立保存会话、工作目录与 SQLite 调度状态；支持课程/作业浏览、单项分配及课程「一键通关」。
- **原生工具 + 内存作用域 CLI 隔离**：作业会话仅挂载 DSH 原生编码工具（`bash`/`pwsh`、`read`、`read_image`、`write`、`edit`、`glob`、`grep`、`job_output`/`job_list`/`job_kill`），不注入 `educoder_*` 专属 tool schema，也不挂载 `plan-mode`/`subagent`/`schedule`/`goal`/`skill`/`web_search`/`todo_write`。每个运行中的 Agent 仅在内存 `ctx.shellEnv` 临时获得当前任务的 `DSH_EDUCODER_*` 环境变量并运行在 `workspace-write` + `never` 沙箱审批策略下，任务结束后立即撤销。
- **工作区可自愈 EduCoder CLI（`./cli/educoder.mjs`）**：`inspect`、`read-file`、`save-file`、`evaluate`、`submit-choices`、`terminal`、`browser`、`images`、`doctor`、`cli-diff`、`cli-restore` 全部下沉到共享工作区 `./cli/`；插件随附 `./cli/.baseline/` 基线快照，支持 Agent 在遇到平台差异时直接通过原生 `read`/`edit`/`bash` 诊断或修复 `./cli/`，并在插件升级时自动保留已修改的源码，同时升级未改动的基线文件。
- **自动评测与读图链路**：支持代码、单选、多选、判断、填空及已配置执行器的 WebSSH 终端关卡；题干附带图片时优先通过原生图片附件传递前 4 张可用图片（超出数量或缺失时可配合 `images --download` / `browser --screenshot` + 原生 `read_image` 查看），评测结果不明或短窗口内尚未收敛时自动读回核验。
- **隔离与转发配套**：提供 [凭据隔离边界](deploy/educoder/凭据隔离.md)、[OpenCode Go 模型转发](deploy/educoder/go-model-relay/README.md)、[OpenCode Go 额度转发](deploy/educoder/go-quota-relay/README.md) 与 [EduCoder 私网连接转发](deploy/educoder/educoder-connect/README.md)。

安装与升级 `@forst/dsh-educoder`（独立于 `@forst/dsh-toolkit` 安装到同一 `web` profile）：

```bash
npm pack ./plugins/educoder --pack-destination dist
dsh plugin --profile web add --ignore-scripts --save-exact "$PWD/dist/forst-dsh-educoder-0.2.0.tgz"
```

## 包含什么

| 组件 | 功能与位置 | 刷新方式 |
| --- | --- | --- |
| 服务器资源 | 侧边栏“浏览器桌面”上方：CPU、内存、硬盘进度条 | 1 秒 |
| OpenCode Go 月额度 | “浏览器桌面”下方、“更多”上方：名称、整数百分比、本月已使用 | 60 秒；服务端共享 60 秒缓存 |
| Pi 会话费用 | 输入框统计行最前面：费用图标与总价；悬停高亮，点击展开原生风格浮窗 | 随会话结算推送 |
| Camoufox 接入配方 | 持久化设备预设和浏览器数据、可见桌面、MCP 浏览器工具、会话独占、按需启动及闲置回收 | 可选 Docker 运行时 |
| Linux 完整桌面 | Xfce、终端、文件管理器和文本编辑器；DSH 官方 Cua Driver MCP 接入，同一 noVNC 桌面 | 可选 Docker 扩展镜像 |

四条进度条统一配色：≤70% 蓝色；>70% 且 ≤90% 黄色；>90% 红色；不可用为灰色。侧栏折叠、页面不可见时暂停刷新；恢复时立即读取。

费用浮窗只列“输入、输出、缓存读”，累计实际产生缓存写费用时才增加“缓存写”。复用当前 DSH 安装的 Pi 目录及 `calculateCost()`，支持刷新、换会话和完整历史回算，不安装第二份 Pi，不修改 DSH 核心。

## 兼容环境

- 已验证基线：DSH `0.2.2-alpha.2`、Node.js `24.22.1`、Pi `1.4.0`；Node 最低 `24.9`。
- 资源采集器适用于有 `/proc` 的 Linux；内存按整机 `MemAvailable` 计算。
- Web UI 使用原生 Cordis、会话投影和客户端扩展点。其他 DSH 版本需要重新验证。
- 浏览器运行时版本、来源和限制见 [Camoufox 说明](integrations/camoufox/README.md)。
- Linux 桌面固定使用 Cua Driver `0.28.0` 和 DSH 官方 MCP provider；与仅支持 macOS 的原生 `cua` 对象接口不同。构建、验证和回滚见 [Linux 桌面说明](integrations/linux-desktop/README.md)。

## 安装一个插件包

0.2.0 的安装包由本仓库 [Actions](https://github.com/blueforst/dsh-toolkit/actions) 成功检查运行的 `dsh-toolkit-server-0.2.0` 构建产物提供。下载并解压后，在运行 DSH 的环境中执行：

```bash
dsh plugin --profile web add --ignore-scripts --save-exact "$PWD/forst-dsh-toolkit-0.2.0.tgz"
```

随后重启运行该 `web` profile 的 DSH 进程。保留下载包的位置，便于后续重新安装。本次代码拆分不会自动升级现有服务器；旧 Release 与部署镜像继续可用。集成目录中的原部署配方保持原版本基线，使用新版包时需明确替换安装命令中的包路径。

如果原来分别装了 `@forst/dsh-server-metrics` 或 `@forst/dsh-session-billing`，先备份 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.yml`、`cordis.patch.yml`，移除旧插件后再安装统一包：

```bash
dsh plugin --profile web remove @forst/dsh-server-metrics @forst/dsh-session-billing
```

仅移除实际安装的旧包即可；不要同时启用新旧入口，以免重复显示。安装器使用 DSH 原生插件管理，不直接改写用户 Cordis 配置。

## 启用整机资源采集

下载并解压 Release 的源码归档，进入目录。在 Docker 宿主机运行：

```bash
# 改成 DSH 实际使用的 Docker 网络名称
sudo python3 scripts/install-host-metrics.py --network YOUR_PROJECT_default --dry-run
sudo python3 scripts/install-host-metrics.py --network YOUR_PROJECT_default
```

采样服务名为 `dsh-toolkit-metrics.service`，以 `nobody` 运行，只绑定所选私有网桥。插件在 Docker 内默认连接网桥的 `9191` 端口。

原生非 Docker 部署可指定 `--bind 127.0.0.1`，并把 `DSH_METRICS_URL=http://127.0.0.1:9191/metrics` 加入 DSH 启动环境。自定义端口、磁盘路径、安装与移除方法见 [部署说明](docs/部署说明.md)。

## 启用 OpenCode Go

把自己的 `OPENCODE_GO_API_KEY` 加入 DSH 的进程环境，月额度即可读取。Compose 或 systemd 部署应修改相应服务环境并重启；只在另一个终端执行 `export` 不会改变已运行服务的环境。

模型接入示例在 [examples/opencode-go.cordis.patch.yml](examples/opencode-go.cordis.patch.yml)，默认 `deepseek-v4.1-flash / Max`。这是配置示例，需合并进现有配置；不要覆盖原文件。凭据始终通过环境变量引用。

Go 接口当前返回整数百分比，不补小数位。没有密钥、请求失败或尚无有效样本时，额度条显示不可用；其他资源条独立更新。

## 费用口径

费用为 **当前安装的 Pi 模型目录估算**，不是 Go 实际额度或额外账单。Pi 目录不一定包含供应商的时段加价、套餐加权和历史价格；没有目录匹配的调用会标记未计价，不当作免费。

统计完整会话日志中有用量记录的模型结算，包括重试与压缩；无用量记录的辅助请求不在金额内，子会话分别统计。输入、输出、缓存读、缓存写是互斥计费桶，推理 token 已包含在输出中。详见 [费用说明](docs/费用说明.md)。

## 从源码打包与检查

构建和测试放到服务器或 CI 执行：

```bash
npm run build
npm run check
DSH_ENTRYPOINT="$(npm root -g)/@deepseek-ai/dsh/lib/bin.js" npm test
node tests/educoder-soak.mjs --duration-ms 4000
python3 -m unittest deploy/educoder/go-model-relay/test_relay.py
python3 scripts/audit-release.py
npm pack --pack-destination dist
npm pack ./plugins/educoder --pack-destination dist
```

统一客户端由两个独立模块的源码生成，不依赖额外打包器。GitHub Actions 会在固定 DSH 基线上执行构建与回归检查。包内无账户数据、会话日志或浏览器配置档。

## 卸载

```bash
dsh plugin --profile web remove @forst/dsh-toolkit
```

重启 DSH。若同时移除宿主采集器，执行 [部署说明](docs/部署说明.md) 中的卸载命令。历史会话无需删除。

## 授权与来源

自编插件和接入脚本按 MIT 授权；第三方运行时、浏览器和上游插件保留各自授权。详见 [NOTICE.md](NOTICE.md)。
