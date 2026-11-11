# VPS 快速开始

当前版本从 GitHub 获取，使用原版界面和纯 Node.js 后台。

```bash
git clone https://github.com/2010384626/all-api-hub.git
cd all-api-hub
bash deploy/setup.sh https://hub.pingu.cc.cd /
bash deploy/start.sh
```

已有旧版部署：不要重新生成加密密钥。复制旧目录的 `.env.web` 到新仓库目录，继续使用 `all-api-hub-web-data` 数据卷，再运行启动脚本。首次迁移与 Nginx 配置详见 [WEB_DEPLOYMENT.md](WEB_DEPLOYMENT.md)。

后续更新：

```bash
bash deploy/update.sh
```

或手动执行：

```bash
git pull --ff-only origin main
bash deploy/start.sh
```

`git pull` 只更新源码，启动脚本负责构建并更新容器。登录密码在 `.env.web` 的 `ADMIN_PASSWORD`；不要丢失 `ENCRYPTION_KEY`，不要执行会删除数据卷的 `down -v`。
