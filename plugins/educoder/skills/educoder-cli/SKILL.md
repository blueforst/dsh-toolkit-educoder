---
name: educoder-cli
description: Manage multiple EduCoder accounts, list courses and homeworks, inspect stages, read/edit remote code, run remote terminals, and submit code or choices using the workspace EduCoder CLI.
whenToUse: Use whenever the user asks to check or solve EduCoder courses, homeworks, tasks, evaluate code/choices, or operate across bound EduCoder accounts inside the EduCoder workspace.
---

# EduCoder Workspace CLI (`educoder-cli`)

在 **EduCoder 专属工作区** 内的 `bash` 工具中，运行时会自动注入以下环境变量（**无需也不得读取宿主机凭据文件**）：

- `DSH_EDUCODER_CLI`: 可编辑 CLI 入口脚本路径（`./cli/educoder.mjs`）
- `DSH_EDUCODER_CLI_ROOT`: `./cli` 源码目录
- `DSH_EDUCODER_SHARED_ROOT`: 共享 EduCoder 工作区根目录
- `DSH_EDUCODER_ACCOUNTS`: 当前工作区已绑定账号快照（JSON）；普通对话可直接通过 `--account` 访问所有可用账号
- 自动做题 Worker 回合中还会额外锁定当前任务的 `DSH_EDUCODER_SESSION`、`DSH_EDUCODER_TARGET`、`DSH_EDUCODER_WORKDIR`

> **安全边界**：切勿 `echo`、打印、持久化或泄露 `DSH_EDUCODER_ACCOUNTS`、`DSH_EDUCODER_SESSION` 或 `DSH_EDUCODER_SIGNING_*` 中的 Cookie / 密钥。

## 1. 账号与课程查询

```bash
# 查看可用账号列表（只输出脱敏标识 id / label / remoteUserId / status / hasSession）
node "$DSH_EDUCODER_CLI" accounts [--json]

# 查看课程列表（多个可用账号时必须带 --account <id|label|remoteUserId>）
node "$DSH_EDUCODER_CLI" courses [--account <selector>] [--json]

# 查看指定课程下的实训作业与完成情况
node "$DSH_EDUCODER_CLI" homeworks --course-id <courseId> [--account <selector>] [--json]
```

账号选择规则：
- 若提供 `--account <selector>`，按账号 `id`、`remoteUserId` 或唯一匹配的 `label` 选择会话；若显式传入 `--account` 且切换了目标课程/作业，会清除从环境变量继承的旧关卡 `binding`。
- 若未传 `--account`：在自动 Worker 会话中默认使用 `DSH_EDUCODER_SESSION`；在普通对话中若仅有 **1 个** 可用（`hasSession && ready/unverified`）账号则自动选中，若有多个可用账号或无可用账号则会提示先运行 `accounts` 或传入 `--account`。

## 2. 读取题面与关卡通关

- 对多账号或普通对话，`inspect` / `read-file` / `save-file` / `evaluate` / `submit-choices` / `terminal` / `browser` / `images` 只需提供 `--course-id` 和 `--homework-id`（可省略 `--task-id`，默认解析当前/首关；查看特定关卡时传 `--task-id <id>` 或 `--advance-to <nextTaskId>`）：

```bash
# 查看关卡题面、允许编辑文件列表与当前状态（加 --no-open 可避免首次自动打开副作用）
node "$DSH_EDUCODER_CLI" inspect [--account <selector>] --course-id <cid> --homework-id <hid> [--task-id <tid>] [--json]

# 下载题面附图
node "$DSH_EDUCODER_CLI" images --download "$WORKDIR" [--account <selector>] --course-id <cid> --homework-id <hid>

# 无头浏览器查看（仅在启用时）
node "$DSH_EDUCODER_CLI" browser [--screenshot "$WORKDIR/page.png"] [--account <selector>] --course-id <cid> --homework-id <hid>
```

### 代码 / 终端 / 选择题操作

```bash
# 读取平台代码文件
node "$DSH_EDUCODER_CLI" read-file [remotePath] --out <localPath> [--account ...] --course-id <cid> --homework-id <hid>

# 保存完整代码到平台（tab_type=1, evaluate=0）
node "$DSH_EDUCODER_CLI" save-file [remotePath] --from <localPath> [--account ...] --course-id <cid> --homework-id <hid>

# 触发评测并等待结果（传 --from 时会自动先保存再评测；加 --no-wait 立即返回）
node "$DSH_EDUCODER_CLI" evaluate [--from <localPath>] [--account ...] --course-id <cid> --homework-id <hid>

# 提交选择/判断/填空答案（按 inspect 题序，例如 '["A","BC",true]'）
node "$DSH_EDUCODER_CLI" submit-choices --answers '["A","BC"]' [--account ...] --course-id <cid> --homework-id <hid>

# 执行远端关卡终端命令（仅在启用且关卡支持终端时可用）
node "$DSH_EDUCODER_CLI" terminal [--account ...] --course-id <cid> --homework-id <hid> -- <command>
```

> **读写分离原则**：用户仅要求查看课程、进度、题面或起始代码时，只使用只读命令（`accounts`、`courses`、`homeworks`、`inspect`、`read-file`、`images`、`browser`），不要擅自提交或改写代码。

## 3. 自检与 CLI 维护

```bash
node "$DSH_EDUCODER_CLI" doctor [--json]
node "$DSH_EDUCODER_CLI" cli-diff [--json]
node "$DSH_EDUCODER_CLI" cli-restore [<relativePath> | --all]
```

如果 `./cli/` 在解析头歌新接口或特殊题型时存在 Bug，可以直接修改 `./cli/` 源码（`./cli/.baseline/` 为只读基线）并用 `cli-diff` / `doctor` 验证；禁止把凭据或密码写入 `./cli/` 或 `.dsh/`。
