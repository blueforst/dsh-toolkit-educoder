# DSH EduCoder 插件

在专用 DSH Web 实例中管理头歌账号、课程、作业和评测。每个账号独立保存会话、工作目录和任务进度。可以分配单项作业，或为多账号批量分配各自的作业。一个账号同一时间只运行一项任务。

在课程区选择账号和课程后，点击「一键通关」即可把该课程的未完成作业（含排队前已暂停的任务）加入执行队列；已通过或已提交客观题进入「待评审」（未公开评分结果）的作业均计入课程完成进度并会被跳过。需要人工处理、待评审或重试的作业可在任务队列按更新时间排序查看，也支持手动恢复或取消。

真实作业的会话通过 DSH 原生 `SessionController` 创建并集中在「EduCoder」共享工作区，执行结束后保持 `idle` 常驻会话而不手工销毁（可在会话界面继续查看历史或直接追问）。插件不对宿主挂载全局工具守卫，普通 DSH 会话保留完整原生能力；同时仅在「EduCoder」工作区与 EduCoder Worker 会话内通过内存 `ctx.shellEnv` 注入实时全账号快照 `DSH_EDUCODER_ACCOUNTS` 与共享 CLI 环境（普通工作区对话不注入任何 `DSH_EDUCODER_*` 变量），并在工作区 `.dsh/skills/educoder-cli/SKILL.md` 下提供 DSH 原生可发现的使用技能，无需向提示词注入多账号冗长说明。仅在 EduCoder 作业单轮运行期间于当前 `agentCtx.tools` 限定只保留 DSH 原生编码能力（`bash`/`pwsh`、`read`、`read_image`、`write`、`edit`、`glob`、`grep`、`job_output`/`job_list`/`job_kill`），并在工作区 `./cli/` 下提供完整、可编辑自愈的 EduCoder CLI（`node "$DSH_EDUCODER_CLI" <subcommand>`）。模型开始解题时会参考工作区的 `./解题经验.md`，评测通过后可使用 `edit` 补充一条通用经验。

同一份作业在上一轮模型请求后的 24 小时内重试或进入已核验的下一关时，优先复用原 DSH 会话；自动 Worker 回合每次通过 DSH `ctx.shellEnv` 仅在内存中向当前 Agent 的子进程注入作用域化的 `DSH_EDUCODER_SESSION`/`TARGET`/`WORKDIR` 与全账号 `DSH_EDUCODER_ACCOUNTS`（并在回合结束后立即撤销任务级隔离变量），不写入宿主环境或工作区配置文件。下一关追加新题面、图片和公开样例，并更新目标关卡绑定。已归档、被占用或超过窗口时创建新会话；除非显式传入预算上限，不再对单轮模型步数、运行时长、总 token 或单次续关数设置低额默认限制。模型实际读取的缓存由服务商决定。写入或评测状态不明时，worker 会结合 `.educoder-cli-state.json` 保存证据与平台读回核验结果。Web 面板提供脱敏日志和会话入口。

所有 EduCoder 平台操作均通过工作区 CLI 完成：

- `accounts` / `courses` / `homeworks` / `--account <id|remoteUserId|label>`：在 EduCoder 工作区查看已绑定账号（不输出原始 Cookie）、查询课程与实训作业，以及自由切换目标账号
- `inspect` / `read-file` / `save-file` / `evaluate` / `submit-choices` / `terminal` / `browser` / `images`（普通对话支持仅传 `--course-id` 与 `--homework-id` 自动解析当前/首关）
- `doctor` / `cli-diff` / `cli-restore`：支持检查依赖、对比 relative-to-`.baseline` 的改动，以及在模型修复 `./cli/` 后跨任务、跨重启和插件升级保留自定义补丁（未修改的文件随插件升级自动更新，必要时可用 `cli-restore` 还原）。

作业回合仅保留上述原生编码工具，屏蔽 `plan-mode`、`schedule`、`subagent`、`goal`、`skill`、`web_search`/`web_fetch`、`todo_write` 等非编码工具与所有 `educoder_*` 专属工具（普通会话不受影响）；题干含图片时优先通过原生图片附件传递前 16 张可用图片（若超限或缺失，可搭配 `images --download`、`browser --screenshot` 与原生 `read_image` 读取）。启用 `DSH_EDUCODER_BROWSER_INSPECTION=1` 且满足网页查看条件时开放 `browser` 子命令（无网络拦截）。每关支持自动重试（默认最多 12 次尝试）；独立 VNC 图形实训仍需人工处理。

真实账号默认关闭。启用需要专用实例、通过检查的凭据隔离补丁、已授权的 EduCoder 签名配置，以及用户在受保护页面输入账号信息。真实作业执行另需显式启用并指定模型。DSH 以本地凭据服务保存会话，插件不保存原始密码。操作命令与回滚方式见 [开发实例部署](https://github.com/blueforst/dsh-toolkit-educoder/blob/main/deploy/educoder/README.md)。

许可证为 MIT。EduCoder 协议参考了 MIT 许可的 [educoder-cli 源码](https://github.com/lihaoze123/educoder-cli/tree/5e76e15ffcb364edecde74381577d8f7f4470dcf)。
