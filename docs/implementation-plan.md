# 实现说明

目标：主 agent 主动查询子 agent，了解当前状态和已保存的执行过程；观察对子 agent 无感。

## 直接的读取路径

```text
主 agent 调用工具
  → 官方 SDK 连接已有 OpenCode 服务
  → 检查目标属于调用者
  → 读取会话状态、消息或指定消息
  → 返回状态与有限长度的记录
```

只有 list_subagents 和 inspect_subagent 两个工具。没有后台任务、事件订阅、日志回放、增量水位、快照退化或第二套会话存储。
轮询频率和如何利用结果由主 agent 决定。

## 复用官方能力

| 职责 | 实现 |
| --- | --- |
| 插件加载与工具注册 | Plugin.define、tool.transform |
| 连接与认证 | Service.discover、Service.headers、OpenCode.make |
| 子任务发现 | session.list，以调用者 ID 过滤 parentID |
| 当前执行状态 | session.get、session.active |
| 消息分页与详情 | message.list、session.message.get |
| 待授权状态 | permission.request.list，按目标会话过滤 |
| 参数校验 | Zod Standard Schema |
| 长消息内容指纹 | Bun.hash |
| 类型检查、测试、构建 | Bun 原生工具链 |

查询始终只用公开读取接口，不导入 Core/Server 内部实现，不自行处理 HTTP、SSE 或凭证文件。
插件不会启动、替换或停止宿主服务。

## 代码结构

- src/index.ts：注册两个工具，用官方 context hook 向可派发子任务的主 agent 说明只读查询政策。
- src/client.ts：发现现有服务或连接显式地址。
- src/observe.ts：目标归属、读取编排和当前状态判断。
- src/messages.ts：预览、保留消息与工具条目、完整消息分段读取。
- src/schema.ts：少量工具参数及配置。

会话消息是唯一过程数据源。普通查询直接读取最新页，历史查询使用官方 cursor。
查看旧记录或指定消息时，同时读取最新页，避免把过去的工具状态当成当前状态。
所有可见消息类型均保留，assistant 没有正文但存在错误时也会返回。

## 内容长度

每页的正文预算分配给各消息/片段，长文本不会吞掉其他条目的 ID、工具名称和状态。
预览被截断时可通过 messageID 读取完整可见消息，再用 offset 继续读。
revision 是内容指纹，用于避免将执行过程中变化的同一消息拼接成错误内容；不缓存消息副本。
原生 provider checkpoint 与传输元数据不属于可见会话内容，不返回。

## 保留必要约束

- 目标必须是调用者的直接子任务且不是 fork，调用者 ID 来自工具上下文。
- 分页、归属、输入、输出长度和取消检查只服务于实际查询正确性。
- active 与上次 outcome 分开，不把工具失败或静默误判为任务失败/完成。
- 不设精确宿主版本门禁；使用实际公开接口并记录已验证版本。
- 不包装内置 subagent executor，不替换其返回文本或参数描述。

主 agent 的查询政策通过官方 context hook 添加。只有同时具备派发工具和观察工具的上下文才会收到它；普通 general 子 agent 无需任何观察指令。
原生后台完成通知保持由 OpenCode 处理。

## 能力边界

能够读取宿主已经保存的消息、工具参数/结果、可见推理，以及查询时的状态。
不重放每个瞬时状态，不读取未暴露的内部推理，也不承诺取得尚未保存的流式片段。
两次查询间完成的工具调用，仍可从保留的消息历史中读取。
