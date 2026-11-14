# 版本记录

## @forst/dsh-educoder 0.2.9 · 2026-11-14

- **DSH 原生 `SessionController` 常驻会话流程**（`0.2.7` → `0.2.9`）：作业会话改由 `sessionController.create()` 创建与恢复，`Agent` 回合结束后正常回到 `idle` 并留在「EduCoder」工作区与侧栏会话列表中，不再人工调用 `session/disposed` 或移除面板会话。
- **移除宿主全局 `tools.guard` 边界**（`0.2.8`）：删除向 DSH 宿主注册的全局工具拦截器，普通用户会话完整保留 DSH 原生工具，仅在 EduCoder 作业单轮运行期间于当前 `agentCtx.tools` 上用 `restrict`/`guard` 限定原生编码工具、`workspace-write`/`never` 与内存 `ctx.shellEnv` 环境变量。
- **待评审任务计入完成**：客观题结果未公开时收口为 `pending_review`（「待评审」，保留手动恢复与取消操作、不计入异常角标），同时在课程目录完成度进度、「未通关 / 已通关」筛选、一键通关按钮状态与 `startCourse` 中按已完成计算并跳过；任务队列默认按更新时间倒序显示并支持切换排序。
- **工作区可自愈 CLI 与证据核验**（`0.2.3` → `0.2.6`）：EduCoder CLI 下沉至共享工作区 `./cli/` 并附带 `.baseline/` 升级合并基线、`ctx.shellEnv` 按 Agent 内存作用域注入凭据、`educoder-submit-choices` 批量/顺序客观题提交通道以及 `.educoder-cli-state.json` 保存证据读回。

## @forst/dsh-toolkit 0.2.2 · 2026-11-14

- 同步 `@forst/dsh-toolkit-local@0.1.4`：包含 Vertex AI（`gemini-4-carbon`、`gemini-4-hydrogen`）补充费率、DSH `0.2.2-rc.2`/`rc.3` CSS anchor 浮窗定位兼容与 `DSH_OPENCODE_GO_USAGE_URL` 私网代理支持。
- 为 Pi 会话费用新增 `opencode-go-native` -> `opencode-go` 内置目录别名回退并升级投影版本号（自动重算历史缓存在内），修复经由私有 Go relay（`opencode-go-native/deepseek-v4.1-flash`）的会话未计价问题，同时保持任意未知自定义网关不套用估计价格。

## 0.2.1 · 2026-11-13

- 为 `/opencode-go-quota` 增加 `DSH_OPENCODE_GO_USAGE_URL` 私网额度代理支持。

## 0.2.0 · 2026-11-10

- 将个人电脑使用的 Go 月额度与 Pi 会话费用分离到 `blueforst/dsh-toolkit-local`，本仓库明确定位为 Linux 服务器版。
- 服务器包保留原名称和 Cordis 入口；通用功能固定复用本机仓库的提交快照，完整包含在单个发行包中，不要求额外安装本机包。
- `server-metrics` 仅维护 CPU、内存、硬盘采集展示；额度不再与 Linux 资源采集耦合。
- 费用口径、投影键、侧栏位置和费用浮窗保持原行为；原重复费用源码已移入本机仓库维护。
- 增加共享快照哈希与来源检查，以及两个项目独立的构建和回归门槛。
- 不修改现有 Camoufox、Linux 桌面、CUA、Docker、systemd 或生产部署；不执行任何数据迁移。

版本号对应源码和构建包，实际部署需用户另行选择升级。

## 0.1.2 · 2026-11-03

- 增加可选 Xfce 完整桌面扩展镜像，提供终端、文件管理器、文本编辑器及中文字体。
- 通过 DSH 官方 Cua Driver MCP provider 接入 Linux X11 / AT-SPI；驱动固定 `0.28.0` 并验证归档摘要。
- 完整桌面使用原 noVNC 入口，按钮更名“桌面”，桌面设置和工作文件沿用持久卷。
- 增加无障碍、截图坐标输入、浏览器兼容和 Web UI 的真实验收脚本；完整桌面默认内存上限 6 GiB，内存与 swap 总上限 7 GiB。
- 完整桌面模式关闭任意键鼠自动唤醒浏览器，保留快捷方式启动、Browser Use 和三十分钟闲置回收。
- 浏览器 broker 支持显式打开安全的 `about:blank`，拒绝其他非 HTTP/HTTPS URL。

## 0.1.1 · 2026-11-01

- Camoufox 运行时升级到 `1.1.0`：按需启动，默认三十分钟闲置后释放整个浏览器。
- 健康检查与标签页轮询不唤醒或续期；桌面键鼠输入可唤醒并保护浏览器。
- 工具执行和下载期间暂缓回收；保留登录数据与设备预设，关闭旧标签页。
- `browser_close` 真正关闭共享实例，并提示 AI 完成浏览器任务后释放。
- 外层 MCP 会话可跨浏览器回收继续工作；stdio 退出发送 DELETE 清理远端会话。
- 增加生命周期回归和独立容器中的真实浏览器验收脚本。

## 0.1.0 · 2026-11-01

- 首次发布统一的 `@forst/dsh-toolkit` 原生 DSH bundle。
- 整合资源与 Go 额度模块，基于独立版 `0.1.6`；资源 1 秒、额度 60 秒刷新。
- 整合 Pi 会话费用模块，基于独立版 `0.1.4`；费用入口最前、点击浮窗、零费用缓存写隐藏。
- 增加可配置资源采集地址、通用 Linux 采集器安装脚本及单包安装说明。
- 自定义 HTTP 接口显式复用原生 Connection 的登录、Host 和 Origin 校验。
- 附 Camoufox 固定版本运行时、MCP 接入及 OpenCode Go 配置示例。
- 加入构建、回归测试、发布内容检查和 GitHub Actions。
