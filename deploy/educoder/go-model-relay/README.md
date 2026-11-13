# EduCoder 的 OpenCode Go 模型转发

当专用 DSH 实例只能通过私网访问宿主时，宿主转发器提供 DeepSeek V4.1 Flash。OpenCode Go 密钥由 systemd 读入转发进程。DSH 通过独立令牌发起流式请求。关卡可以使用代码工具、终端工具、关卡浏览器，或同时使用代码和终端工具。代码和终端工具组可搭配关卡浏览器，各组也可包含经验记录工具。转发器使用每个 DSH 会话的稳定标识，仅保留安全作用域、输出上限（最高 `384000` tokens）和并发连接容量控制（`64` 槽位），不再对单会话或每分钟请求次数做低额截断。当前模型使用非思考模式。

原生 DSH 聊天通过 `/native/v1/chat/completions` 请求同一模型，支持 Standard 预设及其函数工具。两个入口使用同一私网访问令牌，不再限制长对话消息条数或单会话调用次数。应把该令牌交给受信任的 DSH 管理实例。

DSH 将图片作为内嵌图像传给模型。原生入口每个请求最多携带 128 张图片，在编码前每张最多 4 MiB、合计最多 32 MiB；专用关卡入口每个请求最多携带 16 张图片，在编码前每张最多 2 MiB。支持 PNG、JPEG、WebP 和 GIF。转发器只接受用户消息中的内嵌数据，拒绝外链图片地址。

在宿主核对 Docker 私有网桥的网关地址和 DSH 客户端地址。使用固定容器地址时，建议把客户端网段设为该地址的 `/32`。将以下配置写入 `/etc/dsh-secrets/educoder-go-relay.env`，地址以现场配置为准。

```dotenv
DSH_GO_MODEL_BIND=172.18.0.1
DSH_GO_MODEL_CLIENT_NETWORK=172.18.0.0/16
```

在 `/etc/dsh-secrets/educoder-go-relay.token` 保存至少 32 字符的随机令牌，文件权限设为 0600。把同一令牌通过 DSH 专用实例的受限环境文件注入 `DSH_GO_MODEL_TOKEN`。OpenCode Go 密钥由现有 `/etc/dsh-secrets/opencode-go.key` 提供。

```bash
sudo install -m 0755 opencode-go-model.py /usr/local/libexec/dsh-opencode-go-model.py
sudo install -m 0644 dsh-opencode-go-model.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-opencode-go-model.service
```

把同目录的 [模型配置](model.patch.yml) 合并到活动 DSH Web 配置的 `profiles/web/cordis.patch.yml`，将其中的 `baseURL` 网关改为转发服务的绑定地址。设置页可以修改这份配置。公网普通聊天会话使用 `opencode-go-native/deepseek-v4.1-flash`（允许调用 DSH 原生工具）；公网作业会话虽使用同一模型路由，但在插件侧隔离限制下仅调用当前关卡工具。独立验收可用 `opencode-go`，该路由只接受关卡工具组合。两条路由分别计量会话请求。

模型配置中的 `cacheRetention: long` 让 DSH Pi 适配器向本地转发服务发送 `prompt_cache_key`。转发服务使用它生成同一 DSH 会话的 `X-OpenCode-Session`，并在发往 OpenCode Go 前移除两个 OpenAI 缓存字段。缓存命中及实际有效时间由上游决定。

用已授权的代码关卡核对模型 Session 和平台评测结果。容器网络重建后重新核对网关与客户端网段。回滚时从 DSH 配置移除模型转发设置，恢复原作业入口配置，停用 `dsh-opencode-go-model.service`。

在此目录运行 `PYTHONDONTWRITEBYTECODE=1 python3 test_relay.py`，用本地替身检查工具范围、会话标识、流式响应和图片请求限制。
