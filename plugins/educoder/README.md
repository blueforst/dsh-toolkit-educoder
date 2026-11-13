# DSH EduCoder 插件

在专用 DSH Web 实例中管理头歌账号、课程、作业和评测。每个账号独立保存会话、工作目录和任务进度。可以分配单项作业，或为多账号批量分配各自的作业。一个账号同一时间只运行一项任务。

DSH 为每个关卡创建独立会话，关卡工具只能操作所选账号的关卡。插件根据 EduCoder 返回的关卡状态确认通过。写入结果不明时，恢复操作会先核对平台状态。Web 面板使用当前 DSH 登录和 Origin 检查，并提供脱敏日志和会话入口。

当前配方支持模拟账号的代码题和多文件保存。终端适配器需要由受信任的宿主提供经过验证的执行器，默认标记为需人工处理。选择题、图形题及登录验证等场景也会进入人工处理状态。

真实账号默认关闭。启用需要专用实例、通过检查的凭据隔离补丁、已授权的 EduCoder 签名配置，以及用户在受保护页面输入账号信息。首次真实登录和指定作业提交应分别验收。DSH 以本地凭据服务保存会话，插件不保存原始密码。操作命令与回滚方式见 [开发实例部署](https://github.com/blueforst/dsh-toolkit-educoder/blob/main/deploy/educoder/README.md)。

许可证为 MIT。EduCoder 协议参考了 MIT 许可的 [educoder-cli 源码](https://github.com/lihaoze123/educoder-cli/tree/5e76e15ffcb364edecde74381577d8f7f4470dcf)。
