# 选型与兼容性记录

核查日期：2026-10-19。

## 实际环境与版本策略

| 项目 | 实际版本 / 用途 |
| --- | --- |
| Bun | 最新稳定版 1.4.3，安装在 `/root/.bun/bin/bun`，已加入命令搜索路径 |
| 已安装的 OpenCode | 2.0.32；连接现有后台服务，没有启动或替换该服务 |
| 官方 plugin / client | 2.0.32，匹配本次联调环境，精确锁定用于构建复现 |
| Zod | 4.1.8，通过 Standard Schema 定义工具输入和输出 |
| TypeScript | 7.0.2；类型检查使用 Bun 1.4.3 的 `bun --check` |
| 模型 | `opencode/mimo-v2.6-flash-free`，测试前检查输入/输出费用为零 |

插件没有 supportedVersion、精确版本字符串比较或按版本拒绝加载的门禁。
Service.discover 使用官方健康发现机制，工具在调用时依赖实际公开 API。
没有对其他宿主版本做过联调，故不声称所有 V2 版本均已验证。
升级宿主不要求修改版本常量；若接口能力变化，按实际错误或不可见字段处理。

最初设计核查的是旁边源码仓库 2.0.23，commit `0fd7e2829449b052abf0078666669302923d77af`。
开发时发现实际安装版本为 2.0.32，改用对应发布包验证导出和类型；没有修改 OpenCode 源码。

## 复用的现成能力

- Plugin.define、工具 transform、session context hook：官方插件 API。
- OpenCode.make、会话与消息读取、有限日志迭代：官方生成客户端。
- Service.discover / Service.headers：官方服务发现和认证，不自己读取凭证文件。
- Zod Standard Schema：输入与配置边界校验、工具输出 Schema。
- Bun：安装、原生 TypeScript 类型检查、测试和构建。

没有自建 HTTP/SSE 客户端、会话数据库、事件总线、任务调度器或 LLM 摘要器。
自己编写的逻辑只负责关系检查、读取编排、字段选择、输出限制和主会话提示适配。

## 联调确认的接口边界

1. 插件 Context 的 session API 不包含完整 list/active/log 等方法，使用官方客户端补足。
2. 带结构化 output 的工具必须声明 output Schema；初轮模型测试发现并修复此问题。
3. 本地目录插件需要 Host 能识别的入口；提供根目录 server.js 和包 exports。
4. 插件初始化是异步的，初次 plugin.list 不一定已显示全部本地插件。
5. 同一 assistant 消息会发生内容更新，snapshot 每次重新读取最近投影。
6. text/reasoning 临时 delta 不等于已投影文本，纯 pull 不承诺逐 token 观察。
7. 活动集合是当前进程的视图，outcome 是上次结果，二者分开返回。
8. 后台返回文本与参数描述都包含禁止轮询提示，适配只作用于主会话看到的说明与结果。
9. 历史页复用官方 cursor，单条消息使用 session.message.get；二者不会影响当前活动页的判断。
10. 正文预览分配给每个片段，长消息通过 offset 续读；内容指纹复用 Bun.hash，不增加依赖或状态存储。

## 当前宿主的持久日志正文缺口

对本次真实测试子会话，官方 `session.log({ after: 0, follow: false })` 只返回 log.synced 和非零 seq，未返回事件正文。
通过官方客户端注入的 fetch 调试回调检查了原始响应，确认不是本插件把事件过滤掉了。
未修改宿主，也没有对该现象的内部原因作结论。

changes 模式有两条路径：

- 宿主返回正文：按 seq 返回有限持久事件增量。
- 宿主只推进序号：明确返回 historyUnavailable=true、说明文字、当前 snapshot 和 nextAfterSeq。

第二条路径能在水位推进时读取当前过程，但不能重建两次轮询间的每个中间事件。
不建立另一个事件存储，不增加 live 订阅，也不把空正文报告为“没有执行过任何工作”。

## 官方资料

- [OpenCode V2 插件](https://opencode.ai/v2/docs/build/plugins/)：生命周期、工具、hook 与加载。
- [OpenCode V2 JavaScript 客户端](https://opencode.ai/v2/docs/build/client/)：生成 API、取消、发现和认证。
- [Bun 安装](https://bun.sh/docs/installation)：官方稳定版安装方式。
- [Bun 发布记录](https://bun.com/blog)：本次安装时稳定版为 1.4.3。
- [Bun 测试](https://bun.sh/docs/test)：内置行为测试。

官方文档可能领先于已安装版本，以实际发布包类型和真实交互为准，不照搬 V1 插件示例。
