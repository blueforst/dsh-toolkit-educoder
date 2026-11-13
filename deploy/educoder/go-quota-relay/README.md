# OpenCode Go 额度转发

宿主服务从 systemd 凭据文件读取密钥，访问 OpenCode Go 月额度接口，并向 DSH 返回用量百分比、状态和重置时间。服务只接受 Docker 私有网桥内的 `GET /usage`，成功结果缓存 60 秒。

在宿主机先确认 DSH 网络的 IPv4 网关和网段：

```bash
sudo docker network inspect dsh-educoder-dev_default \
  --format '{{range .IPAM.Config}}{{.Gateway}} {{.Subnet}}{{end}}'
```

将服务单元里的 `DSH_GO_QUOTA_BIND` 和 `DSH_GO_QUOTA_CLIENT_NETWORK` 改成查到的网关与网段。凭据文件应由 root 持有且权限为 0600，路径默认为 `/etc/dsh-secrets/opencode-go.key`。在本目录执行：

```bash
sudo install -m 0755 opencode-go-quota.py /usr/local/libexec/dsh-opencode-go-quota.py
sudo install -m 0644 dsh-opencode-go-quota.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-opencode-go-quota.service
```

给运行 Toolkit 0.2.1 或更新版本的 DSH 容器配置 `DSH_OPENCODE_GO_USAGE_URL`。例如网关为 `172.18.0.1` 时，设置 `http://172.18.0.1:9192/usage`。重建 DSH 容器后，在容器内验证转发接口。Docker 网络重建后重新核对网关、网段和容器环境变量。

```bash
sudo docker exec dsh-educoder-dev-dsh-1 node -e \
  'const r=await fetch(process.argv[1]);if(!r.ok)process.exit(1);console.log((await r.json()).usage.monthly.percent)' \
  http://172.18.0.1:9192/usage
```

卸载时从 DSH 容器配置移除额度转发环境变量并重建容器，再停用和移除宿主服务：

```bash
sudo systemctl disable --now dsh-opencode-go-quota.service
sudo unlink /etc/systemd/system/dsh-opencode-go-quota.service
sudo unlink /usr/local/libexec/dsh-opencode-go-quota.py
sudo systemctl daemon-reload
```
