# EduCoder 开发实例部署

本配方以 Toolkit `0.2.0` 验证过的 DeepSeek Harness `0.2.2-alpha.2` 为基线。Docker 镜像由社区项目 `runzhliu/deepseek-harness-docker` 封装，包含官方 DSH npm 发行物。Compose 通过完整镜像摘要固定本次运行时，默认仅在宿主机 `127.0.0.1:13080` 发布 DSH Web。DSH 的配置、凭据、会话和工作区分别保存在项目专属命名卷中。

默认关闭浏览器桌面和 Browser Use。Toolkit 提供的 [Camoufox](../../integrations/camoufox/README.md) 与 [Linux 桌面](../../integrations/linux-desktop/README.md) 可另行构建和验收。仅在专用实例和受保护入口中启用桌面。

## 从零安装

在源码目录中构建并打包。将 `deploy/educoder` 下的文件和产物一起复制到服务器的专用目录，例如 `/opt/dsh-educoder-dev`。

```bash
mkdir -p deploy/educoder/packages
npm pack --pack-destination deploy/educoder/packages
npm pack ./plugins/educoder --pack-destination deploy/educoder/packages
sha256sum deploy/educoder/packages/*.tgz
```

在目标服务器上核对复制后文件的校验和，然后运行以下命令。若当前 Docker 未启动，可由服务器管理员先执行 `sudo systemctl start docker.service`。

```bash
cd /opt/dsh-educoder-dev
sudo docker compose config --quiet
sudo docker compose up -d --wait --wait-timeout 60
sudo docker compose exec -T dsh dsh plugin --profile web add --ignore-scripts --save-exact /opt/educoder-packages/forst-dsh-toolkit-0.2.0.tgz
sudo docker compose restart dsh
sudo docker compose up -d --wait --wait-timeout 60
sudo docker compose exec -T dsh dsh plugin --profile web list
```

通过 SSH 转发访问 Web。使用指向该开发服务器的 SSH 别名。如果外部 SSH 连接由跳板转发，在本地 SSH 配置中维护正确的跳板。远端端口从 `DSH_EDUCODER_WEB_PORT` 读取，以下命令假定使用默认值。

```bash
ssh -N -L 127.0.0.1:13080:127.0.0.1:13080 dsh-2c8g
```

容器的启动日志含一次会话启动凭据。由有权限的操作者私下读取最新的 `dsh web:` 行，并将其路径和参数用于本地 `http://127.0.0.1:13080/`。浏览器换取 Cookie 后会跳转至不带凭据的路径。访问密钥、完整启动 URL 与原始日志应留在授权终端。

模型与凭据入口在 DSH Web 的「设置」→「模型」。基本配方不向容器传递宿主保存的 OpenCode Go 凭据。未安装宿主采集器或未为实例配置 Go 凭据时，Toolkit 的对应指标会显示不可用。参考 [Toolkit 部署说明](../../docs/部署说明.md) 配置采集器和模型。

## 隔离集成验收

固定替身通过项目内部网络提供模型和资源采样。复制替身脚本和配置到专用部署目录下的 `fixtures` 子目录。以下示例从源码仓库根目录准备待复制目录。

```bash
mkdir -p deploy/educoder/fixtures
cp deploy/educoder/fixture-model.patch.yml tests/fixture-server.mjs tests/web-integration.mjs deploy/educoder/fixtures/
```

在服务器上启动组合配置。

```bash
cd /opt/dsh-educoder-dev
sudo docker compose -f compose.yaml -f compose.fixture.yaml up -d --wait --wait-timeout 60
```

同一项目的后续操作应持续使用相同的 Compose 文件参数。替身不绑定宿主端口。使用本地脚本检查受认证保护的资源接口、真实 DSH Web 会话与费用投影。

```bash
sudo bash smoke-fixture.sh
```

回到纯基线前，先停止测试组合，然后用基础 Compose 启动。命名卷仍保留。

```bash
sudo docker compose -f compose.yaml -f compose.fixture.yaml down
sudo docker compose up -d --wait --wait-timeout 60
```

### EduCoder 账号、评测和 Web 面板

在源码目录准备替身文件，将它们和上一步生成的安装包复制到服务器的专用部署目录。

```bash
mkdir -p deploy/educoder/fixtures
cp deploy/educoder/educoder-fixture-model.patch.yml \
  tests/fixtures/educoder-integration.mjs tests/educoder-web-smoke.mjs tests/educoder-client.test.mjs \
  deploy/educoder/fixtures/
```

停止上面的 Toolkit 验收组合后，在服务器专用目录启动 EduCoder 验收组合并安装插件。此组合设置 `DSH_EDUCODER_DEDICATED=1`，只允许选定 EduCoder 关卡使用授权工具。Compose 将 `credential-boundary.patch.yml` 和 `credential-boundary.mjs` 挂载到容器的 `/opt/educoder-deployment/`，由验收组合加载。模拟 EduCoder 和模型服务仅监听 DSH 容器的回环接口。

```bash
cd /opt/dsh-educoder-dev
sudo docker compose -f compose.yaml -f compose.educoder-fixture.yaml config --quiet
sudo docker compose -f compose.yaml -f compose.educoder-fixture.yaml up -d --wait --wait-timeout 60
sudo docker compose -f compose.yaml -f compose.educoder-fixture.yaml exec -T dsh \
  dsh plugin --profile web add --ignore-scripts --save-exact /opt/educoder-packages/forst-dsh-educoder-0.1.1.tgz
sudo docker compose -f compose.yaml -f compose.educoder-fixture.yaml restart dsh
sudo docker compose -f compose.yaml -f compose.educoder-fixture.yaml up -d --wait --wait-timeout 60
sudo bash smoke-credential-boundary.sh
sudo bash smoke-educoder-fixture.sh
sudo bash smoke-educoder-fixture.sh --browser
```

API 验收检查登录和 Origin 防护、宿主文件和上传入口阻断、手动创建会话和发送提示的拒绝、账号隔离、跨账号分配拒绝、并行执行、远端读回、重复分配及会话过期恢复。浏览器验收通过 DSH 的原生面板操作两个模拟账号，并打开对应的 DSH 会话。每次业务验收使用新的模拟账号组，并在终端输出脱敏的 JSON 结果。

### 公网模拟实例

公网模拟实例可在凭据隔离补丁之后加载 `public-settings.patch.yml`。同时把它与 `credential-boundary.mjs` 挂载到容器的 `/opt/educoder-deployment/`。从侧边栏底部「更多」进入「设置」，可以查看原生设置和模型目录。设置写入、凭据更新和模型端点探测由服务端拒绝。真实账号实例继续使用独立的严格配置。

公网模拟实例的 Go 月额度可由宿主转发。安装 Toolkit 0.2.1 并按 [额度转发说明](go-quota-relay/README.md) 配置。真实密钥保存在宿主，DSH 读取用量投影。

### 真实账号开关

真实账号默认关闭。叠加 `compose.credentials.yaml` 会启动独立的 `dsh-educoder-live` 项目，使用单独的凭据和工作区卷，以及宿主回环端口 `13081`。启用前需要在 `DSH_EDUCODER_LIVE_ENV` 指向的受保护文件中设置 `DSH_EDUCODER_LIVE_ACCOUNTS=1`，提供已授权的 `EDUCODER_SIGNING_ACCESS_KEY` 和 `EDUCODER_SIGNING_SECRET_KEY`。同一个环境文件也可引用已配置的 DSH 模型路由。专用实例启动后需要通过运行时的凭据隔离检查。用户通过 SSH 隧道或带认证的 HTTPS 打开 DSH Web 面板后输入账号凭据。权限边界细节见 [凭据隔离](凭据隔离.md)。

通过已启用 HTTPS 和账号验证的 Nginx 提供绑定入口时，再叠加 `compose.public-live.yaml`。设置 `DSH_EDUCODER_PUBLIC_HOST` 为公网入口的主机名或 IP，设置 `DSH_EDUCODER_PUBLIC_NETWORK` 为已创建的 Docker 私有网络。该组合开放账号绑定和课程作业查看，原生设置只读。Nginx 指向新实例的宿主回环端口，签发 DSH 浏览器 Cookie 的同步服务也需切换到新实例。真实实例使用独立卷，不能挂载模拟模型配置。

若宿主无法直连 EduCoder，可按 [EduCoder 出站转发](educoder-connect/README.md) 配置只允许 EduCoder HTTPS 的私网转发。Go 额度可继续使用同一私有网桥上的宿主额度服务。切换前先在回环端口验证新实例。回滚时恢复旧反向代理配置和 Cookie 同步服务，保留新实例的数据卷。

## 重启、备份和回滚

Compose 中的 `restart: unless-stopped` 由 Docker 守护进程执行。需要随宿主启动时，由管理员核实宿主 Docker 已启用，或者通过现有服务器管理方式启动本项目。

升级前保存使用的 Compose 和安装包。停止项目后，使用宿主备份工具备份 `dsh-educoder-dev_dsh-home` 和 `dsh-educoder-dev_workspace` 命名卷。将备份作为凭据存储保护并限制访问。升级后先确认容器健康，再核验受认证保护的页面、会话和目标插件。回滚时恢复原 Compose、包文件与对应的卷快照，随后重启并复验。版本未发生数据结构变化时，可以先用原安装包替换插件并复验，再决定是否恢复卷。

卸载单个插件时，用当前组合的 Compose 文件参数运行 `exec -T dsh dsh plugin --profile web remove @forst/dsh-educoder` 或 `exec -T dsh dsh plugin --profile web remove @forst/dsh-toolkit`，然后重启 DSH。移除开发实例时，使用启动时的 Compose 文件参数执行 `down`，即可保留命名卷和安装包。
