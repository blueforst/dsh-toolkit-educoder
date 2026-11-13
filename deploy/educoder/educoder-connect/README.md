# EduCoder 私网连接转发

当 DSH 宿主无法直连 EduCoder，而另一台同私网主机可以直连时，将此服务部署到后者。转发服务只接受指定 DSH 宿主访问头歌 API `data.educoder.net:443`、头歌网页和静态资源 `www.educoder.net:443` 与 `www-cdn.educoder.net:443`、终端网关 `webssh.educoder.net:443`，以及题面附件 `prod-attachments.oss-accelerate.aliyuncs.com:443`。DSH 与目标站建立 TLS，服务不记录连接数据。

在转发主机核对服务单元的 `--bind`、`--peer` 与两台主机的私网 IPv4，再安装服务。默认端口为 `18087`。

```bash
sudo install -m 0755 -d /usr/local/libexec
sudo install -m 0755 educoder-connect.py /usr/local/libexec/dsh-educoder-connect.py
sudo install -m 0644 dsh-educoder-live-connect.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-educoder-live-connect.service
```

在 DSH 的真实账号实例中设置以下环境变量。头歌请求使用私网转发，DSH 普通模型和工具使用正常网络。

```dotenv
DSH_EDUCODER_HTTPS_PROXY=http://10.8.0.7:18087
DSH_EDUCODER_BROWSER_INSPECTION=1
```

启用浏览器检查后，DS 可以按需读取所选头歌关卡的页面内容。代码保存和评测仍走头歌接口。

从 DSH 宿主验证允许地址的 TLS 响应。OSS 根路径可能返回 HTTP 403，终端网关根路径可能返回 HTTP 404，两者均表示已建立 TLS 连接。访问 `example.com` 应在建立连接前收到转发服务的 CONNECT 403。

```bash
curl --proxy http://10.8.0.7:18087 -sS -o /dev/null -w '%{http_code}\n' https://data.educoder.net/
curl --proxy http://10.8.0.7:18087 -sS -o /dev/null -w '%{http_code}\n' https://www.educoder.net/
curl --proxy http://10.8.0.7:18087 -sS -o /dev/null -w '%{http_code}\n' https://www-cdn.educoder.net/
curl --proxy http://10.8.0.7:18087 -sS -o /dev/null -w '%{http_code}\n' https://webssh.educoder.net/
curl --proxy http://10.8.0.7:18087 -sS -o /dev/null -w '%{http_code}\n' https://prod-attachments.oss-accelerate.aliyuncs.com/
curl --proxy http://10.8.0.7:18087 -sS -o /dev/null https://example.com/
```

已启用真实作业执行的实例可在现有 Compose 文件后叠加 `compose.live-terminal.yaml`，为头歌终端关卡提供 WebSSH 执行器。根路径的 HTTPS 响应只验证转发和 TLS；部署后用已授权的终端关卡确认命令能够执行并返回退出码。

移除时先从 DSH 实例配置删除代理环境变量并重建容器，然后停止转发服务。

```bash
sudo systemctl disable --now dsh-educoder-live-connect.service
sudo unlink /etc/systemd/system/dsh-educoder-live-connect.service
sudo unlink /usr/local/libexec/dsh-educoder-connect.py
sudo systemctl daemon-reload
```
