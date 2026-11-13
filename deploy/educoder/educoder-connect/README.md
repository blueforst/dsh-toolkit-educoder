# EduCoder 私网连接转发

当 DSH 宿主无法直连 EduCoder，而另一台同私网主机可以直连时，将此服务部署到后者。转发服务只接受指定 DSH 宿主发来的 `CONNECT data.educoder.net:443`，TLS 由 DSH 与 EduCoder 建立。服务不记录连接数据。

在转发主机核对服务单元的 `--bind`、`--peer` 与两台主机的私网 IPv4，再安装服务。默认端口为 `18087`。

```bash
sudo install -m 0755 -d /usr/local/libexec
sudo install -m 0755 educoder-connect.py /usr/local/libexec/dsh-educoder-connect.py
sudo install -m 0644 dsh-educoder-live-connect.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-educoder-live-connect.service
```

在 DSH 的真实账号实例中设置以下环境变量。Docker 网桥上的宿主只读服务也可加入 `NO_PROXY`。

```dotenv
NODE_USE_ENV_PROXY=1
HTTPS_PROXY=http://10.8.0.7:18087
NO_PROXY=localhost,127.0.0.1,172.18.0.1
```

从 DSH 宿主验证目标站 TLS 证书和响应。第二条命令应报告 CONNECT 403。

```bash
curl --proxy http://10.8.0.7:18087 -sS -o /dev/null -w '%{http_code}\n' https://data.educoder.net/
curl --proxy http://10.8.0.7:18087 -sS -o /dev/null https://example.com/
```

移除时先从 DSH 实例配置删除代理环境变量并重建容器，然后停止转发服务。

```bash
sudo systemctl disable --now dsh-educoder-live-connect.service
sudo unlink /etc/systemd/system/dsh-educoder-live-connect.service
sudo unlink /usr/local/libexec/dsh-educoder-connect.py
sudo systemctl daemon-reload
```
