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

本机没有 Docker；GitHub Web service 工作流负责 Linux 镜像构建与健康检查。以上为 Web 0.2.0 验收记录；后续生产站点只读诊断及新增功能验收见下文。真实上游调用、人工验证码和 VPS 升级仍需部署验证。页面保留不表示每个站点都提供相同 API；站点能力沿用原适配器。浏览器标签页、OAuth 回调、读取本机环境 Cookie、内容脚本不属于纯 Node 能力，返回明确限制；手动导入 Cookie 请求可用。

## Web 0.3.0：指纹任务与目录持久化更新

2026-11-11；本轮开发基线为 fork `main` 的 `7dd90d448ddcbb7ef60ad9d49b68585a28f94cf7`。延续纯 Node 服务、原版界面及中英文范围；用户授权完成后同步 GitHub，没有请求自动部署 VPS。

### Anyrouter 现场证据与边界

只读查看生产站点中一个失败的 Anyrouter 账户：认证方式为访问令牌，保存值为字面量 `<redacted>`（10 个字符）。仅检查其是否为占位符，未输出或恢复任何真实凭据。此账户不能成功认证的直接原因是导入值已经脱敏；不能据此推断另外一个失败账户也一定相同。

本次在 Web 请求上下文和密钥页面识别占位凭据，给出重新导入真实备份或填写有效 Token / Cookie 的恢复路径。真实凭据未提供，因此不把本地适配器测试表述为生产 Anyrouter 已成功加载。有效凭据的原适配器路径继续保留，不引入猜测的 API 端点。

### 自动验收

本轮完整 Web Node 测试 **79/79 通过**（含 13 项检测任务测试），见[执行日志](artifacts/web-v3-final-tests.log)；相关 Vitest **7 个文件、78/78 通过**，见[执行日志](artifacts/web-v3-related-vitest.log)。请求上下文与脱敏凭据回归另有 **2 个文件、56/56 通过**，覆盖无认证和混合存储凭据情形。下表保留已完成证据及尚待结束的浏览器、钩子和远端检查。

| 场景 / 分支 | 之前 | 本轮预期 | 自动断言 / 命令 | 结果和证据 |
| --- | --- | --- | --- | --- |
| 完整样本的结果百分比、候选展开；不完整样本 | 显示原始排名分数 | 使用 SDK 校准概率显示百分比；无校准或有效样本不足时不编造概率 | `tests/features/ModelFingerprint/DetectionResultCard.test.tsx`、`confidence.test.ts`；`tests/web/detector.test.mjs`；`node e2e/web-native.mjs` | 已有浏览器通过记录：[日志](artifacts/fingerprint-v3-e2e-final.log)、[桌面结果](artifacts/native-ui/fingerprint-desktop.png)、[暗色结果](artifacts/native-ui/fingerprint-dark.png)；最终响应式验收待补 |
| UA、请求头和选项重新打开后保留；未登录 / CSRF 失败 | 依赖当前表单 | 服务器保存配置；认证与 CSRF 校验保留 | `tests/web/detection-http.test.mjs`、`detection-jobs.test.mjs`；浏览器保存后重载断言 | Web Node 79/79 通过；已有浏览器保存和重载通过记录 |
| 流式 / 非流式、并行 / 串行、宽松 / 严格、推理强度和服务等级 | 无独立开关 | 真实请求遵守选项；实时进度在最终结果前送达；严格模式要求正常结束 | `tests/web/detector.test.mjs`、`detection-http.test.mjs`、`security.test.mjs`；`tests/features/ModelFingerprint/stream.test.ts` | Web Node 79/79 及相关 Vitest 78/78 通过 |
| 关闭自动验证后保存样本，再验证 | 无此流程 | 离线比对已保存样本，无额外上游采样 | `tests/web/detection-jobs.test.mjs`、`detection-http.test.mjs`；浏览器断言上游请求数不增加 | 已有服务端和浏览器通过记录：[日志](artifacts/fingerprint-v3-e2e-final.log) |
| 手动成功、部分结果、失败、取消；重启与分页 | 不保留历次结果 | 全部保留，不静默淘汰旧记录；重启标记中断 | `tests/web/detection-jobs.test.mjs`；`detection-http.test.mjs` | Web Node 79/79 通过，含检测任务 13/13 |
| 定时任务创建、编辑、启停、删除；间隔 / 每日；凭据轮换；避免重叠 | 无定时指纹检测 | 默认暂停；每日北京时间；执行时读取当前凭据；删除不清历史 | `tests/web/detection-jobs.test.mjs`、`detection-http.test.mjs`；浏览器任务操作 | 已有后台与浏览器通过记录：[日志](artifacts/fingerprint-v3-e2e-final.log) |
| 模型 / 密钥首次成功加载、重开、手动刷新；刷新失败 | 重复访问上游 | 持久快照无 TTL；显式刷新更新；失败保留上次成功 | `tests/services/webCatalogSnapshots.test.ts`、`webKeySession.test.ts`；浏览器上游计数 | 相关 Vitest 78/78 通过；最终浏览器缓存断言待补 |
| 导入预加载；定时目录刷新关闭 / 未到期 / 到期；并发与删除 | 无共享持久化调度 | 后台导入预加载；按各目录设置刷新；旧响应不覆盖新结果或恢复已删除来源 | `tests/services/webCatalogScheduler.test.ts`、`webCatalogSnapshots.test.ts` | 相关 Vitest 78/78 通过；最终浏览器设置持久化断言待补 |
| Anyrouter 脱敏凭据 / 有效认证方式 | 通用加载失败 | 提示具体恢复方法；未选用的旧凭据不阻断有效认证 | `tests/services/credentialPlaceholder.test.ts`；请求上下文回归测试 | 现场占位符已确认；2 文件 56/56 回归通过，含无认证及混合凭据。真实凭据恢复后的生产读取未运行 |
| 中英文、完整构建和 GitHub | 已有原版 Web 工作空间 | 新控件沿用中英文与主题；保留原菜单；源码推送 fork | 本轮相关 Vitest、Web Node 测试、Web 构建、i18n、类型和钩子检查；GitHub Actions | 待最终提交及远端验证后补充 |

本轮浏览器采用本地真实应用及测试上游响应，没有调用用户的付费 API。视觉基线沿用用户提供的旧结果截图；新历史和调度面板没有对应旧版页面。任务参数及目录快照随原加密存储持久化，浏览器重新加载不是向上游刷新。

本轮 `artifacts/fingerprint-v3-*` 日志及 `artifacts/native-ui/` 截图留在本地供审阅；包括早期失败记录，最终成功后也不自动删除。当前源码、测试和本文保留 Git；旧压缩包及其他原有本地材料保持原状。

## 最终页面（测试数据）

![原版指纹检测](artifacts/native-ui/fingerprint-desktop.png)

![原版总览](artifacts/native-ui/overview-desktop.png)

![原版移动总览](artifacts/native-ui/overview-mobile.png)

截图和日志位于精确忽略的 artifacts/ 目录，仅本地保留待审阅；不向 GitHub 上传用户配置或账户数据。v0.1 压缩包和实验中间件同样保留本地，非当前发布入口。部署步骤以根目录 WEB_DEPLOYMENT.md 为准。

最终浏览器验收已通过（`artifacts/fingerprint-v3-e2e-acceptance.log`）：真实应用测试数据覆盖 Anyrouter 密钥加载、模型/密钥重载复用缓存与手动刷新、两套定时设置持久化、指纹配置/历史/调度/流式/离线验证，以及移动端无横向溢出。用户随后要求立即推送，不追加测试或等待远端流水线。
