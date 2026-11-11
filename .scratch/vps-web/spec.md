# 原版界面的 VPS 运行适配

2026-11-11；原项目基线 af38290894f34722818f4ec1d64d84dc404355cb；Web 0.2.0。

用户选择纯 Node.js 后台；保留原 React 页面和业务模块，在隔离 Worker 中提供存储、定时器、消息及请求运行环境。没有 Chromium 运行依赖。stop-that-shit 0.2.5 advisory skill 已安装到本机 Codex 技能目录并应用本轮开发，不宣称启用了 Hook 拦截。

## 用户场景与证据

| 场景 | 原 Web 0.1 | 当前结果 | 证据 |
| --- | --- | --- | --- |
| 原版总览、账户、凭据、模型、密钥、签到、公告、历史、分析、渠道、同步、设置、导入导出、关于 | 简化独立页面，大量功能缺失 | 直接复用原选项页及业务服务，浏览器遍历 15 个菜单 | e2e/web-native.mjs、artifacts/native-ui/pages.json |
| Anyrouter、Relayfor 导入 | 被两站点白名单过滤 | 原版导入器保留类型、Cookie/Token、请求头、排序、重复合并 | tests/services/importExport/webAccountMigration.test.ts；tests/web/native-runtime.integration.test.mjs；真实 UI 导入 |
| 检测与库联动 | 手工填写 | 同步账户/API凭据，读取已有推理密钥，自动读取其可用模型，保留手动及请求预设 | tests/features/ModelFingerprint/library.test.ts；浏览器实际选择导入凭据并断言检测请求 |
| 中英文与 UI | 独立中文页面 | 原版 UI，两种 Web 语言，手机无横向溢出 | 原版页面截图；zh/en 双向切换、恰好两个选项断言 |
| 去广告 | 简版无广告 | Web 模式不加载赞助目录，不展示推广卡与赞助入口，不发送产品统计 | 原版浏览器验收 |
| 后台持续任务 | 简版签到 | 原版调度在 Node Worker 运行；关闭页面不会停止 | tests/web/extension-runtime.test.mjs；原版历史/用量/公告调度测试 |
| Cookie / UA / Origin | 简版受限 | 显式配置经 Node 转发，复用原运输层校验；不伪造环境登录态 | tests/services/webHeaderOverrides.test.ts；HTTP 代理测试 |
| 原版存储与客户端并发 | 不适用 | 加密写入确认、Web/后台共享锁、事件同步、退出释放 | tests/web/native-http.test.mjs、extension-runtime.test.mjs |
| 旧版数据升级 | 账号与凭据同一简化结构 | 一次性迁移到账户库与凭据库，原加密快照留存 | tests/web/migration.test.mjs |
| GitHub 更新 | 拉原作者 main | 拉 2010384626/all-api-hub main，构建后切换；旧压缩包首次迁移用新目录同数据卷 | tests/web/update.test.mjs；WEB_DEPLOYMENT.md |

本地验证：Web Node 测试 58/58；相关原版与新增 Vitest 一次运行 141/141，指纹/导入/请求头各自聚焦测试也通过；完整类型编译通过；原语言和 Web 中英文分开的 i18n 提取与状态检查通过。Web 原版前后端构建通过。浏览器测试未调用真实付费 API，使用测试响应；测试响应对元数据/公告没有完整模拟，所以日志有回退警告，未造成 JS 异常或资源失败。初期子路径资源与客户端头问题已修复后复跑通过，失败记录仍本地保留。

本机没有 Docker；新增 GitHub Web service 工作流负责 Linux 镜像构建与健康检查。未登录或修改用户的生产网站，真实站点凭据、人工验证码和 VPS 升级仍需部署验证。页面保留不表示每个站点都提供相同 API；站点能力沿用原适配器。浏览器标签页、OAuth 回调、读取本机环境 Cookie、内容脚本不属于纯 Node 能力，返回明确限制；手动导入 Cookie 请求可用。

## 最终页面（测试数据）

![原版指纹检测](artifacts/native-ui/fingerprint-desktop.png)

![原版总览](artifacts/native-ui/overview-desktop.png)

![原版移动总览](artifacts/native-ui/overview-mobile.png)

截图和日志位于精确忽略的 artifacts/ 目录，仅本地保留待审阅；不向 GitHub 上传用户配置或账户数据。v0.1 压缩包和实验中间件同样保留本地，非当前发布入口。部署步骤以根目录 WEB_DEPLOYMENT.md 为准。
