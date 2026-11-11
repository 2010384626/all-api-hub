# All API Hub Web：部署与更新

此 fork 使用原项目的 React 界面与业务服务，提供纯 Node.js VPS 运行环境，不安装或启动 Chromium。登录后进入原版工作空间：总览、账户管理、API 凭据库、模型列表、密钥管理、批量签到、网站公告、余额历史、用量分析、渠道管理、模型同步、设置、导入导出、关于，以及新增的模型指纹检测。Web 界面支持中文和英文，不显示赞助广告或发送产品统计。

后台使用 Node Worker 运行原项目调度和消息处理逻辑；网页通过同源认证接口访问共享存储。账户、API 凭据和历史保存在 `/data/state.enc` 加密文件中，关闭网页后定时任务仍运行。

## 已有 hub.pingu.cc.cd 部署升级

第一次从旧压缩包迁移到 GitHub 版，使用新目录克隆本 fork，不要覆盖旧目录中的配置：

```bash
git clone https://github.com/2010384626/all-api-hub.git all-api-hub-github
cd all-api-hub-github
# 将下面旧目录路径改为你当前 VPS 的部署目录
cp /你的旧部署目录/.env.web .env.web
chmod 600 .env.web
```

保留原 `ADMIN_PASSWORD`、`ENCRYPTION_KEY`，配置应匹配实际访问地址：

```dotenv
PUBLIC_ORIGIN=https://hub.pingu.cc.cd
BASE_PATH=/
```

Docker Compose 项目名和数据卷名称继续使用 `all-api-hub-web`、`all-api-hub-web-data`。同一 Docker 主机切换目录不会更换数据卷。启动前建议先停旧服务并备份数据卷与 `.env.web`；不能丢失加密密钥。不要执行 `down -v`。

```bash
# 在旧目录停止服务，保留数据卷
cd /你的旧部署目录
bash deploy/compose.sh stop

# 切换到新目录，执行测试并构建运行镜像
cd /你的新目录/all-api-hub-github
bash deploy/start.sh
bash deploy/compose.sh logs --tail=100 app
curl --fail http://127.0.0.1:8787/api/health
```

服务第一次读取旧 Web 数据时，会将账户和 API Key 转入原版账户库与 API 凭据库；原来的加密快照仍保留，迁移只执行一次。旧版未曾保存的 Anyrouter、Relayfor 需要重新导入原备份，已经被跳过的数据无法凭空恢复。

## 后续更新

更新来源已改为你自己的 `2010384626/all-api-hub` 仓库 main 分支。源码更新后必须重新构建并启动容器，运行中的容器不会因 git pull 自动改变。

推荐在干净工作区执行：

```bash
bash deploy/update.sh
```

它拉取你的 fork，在临时 worktree 合并与测试构建，备份加密数据后切换镜像；健康检查失败恢复原镜像和数据。合并冲突或测试失败不会切换服务。`--check` 只做候选构建，`--detector 版本 --data 版本` 可以更新固定版本的检测 SDK 与参考库。

也可以手动拉取再构建（此方式没有更新脚本的自动备份回滚）：

```bash
git pull --ff-only origin main
bash deploy/start.sh
```

上游 qixing-jk 的变更应先合入你自己的 fork、验证 Web 适配后再发布。VPS 不直接跟随原作者的 main，以免覆盖正在使用的 Web 改造。

原作者的扩展自动发版流程默认只在原仓库运行；本 fork 使用 Web service 构建验证。若以后需要发行浏览器扩展，另行配置对应密钥并将仓库变量 `ENABLE_EXTENSION_RELEASES` 设为 `true`。

测试和覆盖率报告保留在 GitHub Actions 产物中。向 Codecov 上传默认只在原仓库启用；自行开通该服务后可设置仓库变量 `ENABLE_CODECOV=true`，无需为 VPS 部署配置它。

## 新部署与网站挂载

需要 Linux、Git、Bash、OpenSSL、Docker Engine 与 Docker Compose 插件。无需主机 Node/npm；镜像构建需要连接 npm 和 Docker 镜像仓库。原版 UI 构建依赖较多，建议至少 2 GB 可用内存，资源紧张时在另一台机器构建镜像。

```bash
git clone https://github.com/2010384626/all-api-hub.git
cd all-api-hub
bash deploy/setup.sh https://hub.pingu.cc.cd /
bash deploy/start.sh
```

`setup.sh` 在 `.env.web` 生成密码和加密密钥，不覆盖已有配置。修改环境后运行 `bash deploy/compose.sh up -d --force-recreate`。容器只发布 `127.0.0.1:8787`，Nginx 反代示例见 `deploy/nginx.conf.example`。挂到已有网站子路径时，设置 `PUBLIC_ORIGIN=https://example.com`、`BASE_PATH=/hub/`，转发时保留 `/hub/`。

没有域名时可用 `bash deploy/setup.sh http://localhost:8787 /`，从本机执行 `ssh -N -L 8787:127.0.0.1:8787 用户名@VPS` 后打开 `http://localhost:8787`。

## 账户导入和模型指纹检测

原版导入器保留站点类型、访问令牌、手动 Cookie、API 凭据、请求头、标签与配置。Anyrouter、Relayfor 不再经过旧版的两站点白名单过滤。导入界面支持选择合并或覆盖；先导出当前数据再执行覆盖。

模型指纹检测的“同步账户和凭据”读取同一工作空间的数据。选择账户后读取该账户已有的调用密钥，再查询所选密钥可用的模型；选择 API 凭据则直接读取其地址、密钥、请求头和模型列表。不会为了检测自动创建或轮换密钥。保留手动配置、标准/Claude Code/Codex CLI 预设、自定义 UA 和请求头。

### 请求设置与结果

自定义 User-Agent、请求头以及检测选项自动保存在服务器，页面显示“已保存在服务器”后，刷新页面或下次登录仍可使用。可以分别选择流式输出、并行请求、宽松模式和取样后自动验证，并填写上游支持的推理强度，选择 Flex、默认、Fast 或 Ultrafast 服务等级。流式模式会实时显示样本；关闭并行后依次发送三份样本；宽松模式达到目标数字数时结束流式取样，或裁剪完整回复中的多余数字。

结果展示排名第一的候选、置信度百分比、候选进度条和采样详情。百分比使用检测 SDK 的已校准参考库概率，所有库内候选合计 100%，不是把排名分数直接改为百分比。三份有效样本不足或没有校准数据时，页面会明确显示置信度不可用。

关闭“取样后自动验证”时先保存样本，可稍后点击“验证已保存的样本”进行本地比对，不再向模型发送采样请求。手动和定时检测的历史均保存在服务器，包括不完整、失败和取消记录；点击历史记录可重新查看结果。服务重启后保留历史，未完成的记录标为中断。备份时保留 `/data/state.enc` 和原加密密钥。

检测会消耗上游额度；结果仅反映与参考库模型行为的相似度，不能单独证明模型身份。客户端预设改变应用层请求字段，不模拟真实 CLI 的 TLS 指纹。

### 定时指纹检测

先选择来源、密钥、模型和请求选项，再点击“为当前模型创建任务”。可以设置至少 5 分钟的固定间隔，或每天的指定时间；每日任务按 `Asia/Shanghai`（北京时间）执行。任务初始为暂停状态，启用后即使关闭网页，VPS 仍会执行。

任务保留创建时的请求选项；使用账户或 API 凭据来源时，每次执行重新读取该来源当前保存的凭据。列表支持修改时间、启用、暂停和删除；暂停或删除会取消该任务正在进行的检测，已有历史仍保留。每轮会发送三份真实采样请求，启用前按自己的上游计费情况设置频率。

### Anyrouter 凭据检查

Anyrouter 密钥读取使用原项目适配器。若页面提示“导入的凭据为脱敏占位符”，说明备份中的 Token 或 Cookie 是 `<redacted>`、`[redacted]` 或星号等占位文本，无法用于认证。请从仍保存真实凭据的原插件重新导出备份，或在账户编辑中填写有效访问令牌／手动 Cookie，然后刷新密钥列表。保留站点名称和账户 ID 的脱敏备份无法恢复被移除的密钥。

## 模型列表和密钥管理持久化

首次导入后，后台自动加载可用账户和 API 凭据；首次成功得到的列表保存到服务器。后续打开页面、刷新网页或重启服务直接读取已保存列表，不按时间自动过期。页面中的“刷新”操作会重新请求上游；刷新失败保留上一次成功的快照。修改凭据或成功新增、编辑、删除密钥后，受影响的数据会重新加载。

模型列表和密钥管理各有“列表持久化与定时刷新”设置。定时刷新默认关闭，可分别启用并设置 5 到 43200 分钟的间隔；保存后由 VPS 后台执行，面板显示上次定时刷新及失败来源数。模型刷新覆盖已保存的启用账户和 API 凭据；密钥刷新覆盖启用账户。与指纹检测任务不同，列表刷新只更新目录，不会运行模型指纹采样。

## 运行边界

普通接口操作、手动 Cookie 请求、定时签到、历史采集、分析和管理任务不依赖浏览器。读取你电脑上已登录的网页 Cookie、自动打开验证页面、OAuth 标签页回调、内容脚本和交互式验证码仍属于浏览器能力，纯 Node 服务无法自动完成。遇到此类站点，需要在站点完成验证后更新凭据；接口自身要求人工验证码的签到不能承诺无人值守。

所有站点继续采用原项目各适配器的能力边界，页面可用不代表所有站点开放同样的接口。自动历史采集、用量采集和签到依照设置启用；缺少有效账户凭据时无法采集真实数据。对私网目标的请求默认拒绝，公网 HTTPS 站点可用。

## 本地开发与验证

```bash
# Node 24.15+，pnpm 12.x
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
npm --prefix web ci --ignore-scripts
pnpm build:web
pnpm test:web
# 配置 ADMIN_PASSWORD / ENCRYPTION_KEY / PUBLIC_ORIGIN 后启动
pnpm start:web
```

构建输出为 `web/dist` 和 `web/server/generated`，不提交到 Git，Docker 构建自动生成。Web 运行环境不依赖根目录 node_modules。GitHub `Web service` 工作流构建 Docker 镜像、执行测试并启动健康检查。

原项目 AGPL-3.0 与第三方许可证保留。修改版源码地址为本 fork，可通过 `SOURCE_URL` 指定发布提交。`.env.web`、数据、备份和本地截图不提交到 GitHub。
