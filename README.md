# OpenCode Subagent Observer

主 agent 主动查看子 agent 的当前状态、消息、工具调用和可见推理。查询只读，子 agent 无需配合，也不会收到查询通知。

## 安装与加载

```sh
cd /mnt/data/code/opencode-subagent-observer
bun install --frozen-lockfile
bun run build
```

在目标项目现有的 opencode.jsonc 的 plugins 数组追加本工程路径：

```json
{
  "plugins": ["/mnt/data/code/opencode-subagent-observer"]
}
```

默认连接已经运行的本地 OpenCode 服务，认证使用官方服务发现能力。无需单独启动插件服务。
自定义连接示例见 [examples/opencode.jsonc](examples/opencode.jsonc)；options 支持 baseUrl、headers 和 timeoutMs。
本工程的 `.opencode/plugins/observer/index.ts` 已配置源码开发入口，开发时无需重复配置包入口。

## 使用

只有两个工具：

```js
// 找到自己的子任务
list_subagents({})

// 查看当前状态和最近记录；每次调用都重新读取
inspect_subagent({ sessionID: "子会话 ID" })

// 查看较早记录，cursor 使用上次返回的值
inspect_subagent({ sessionID: "子会话 ID", cursor: "历史游标" })

// 按消息 ID 查看完整内容
inspect_subagent({ sessionID: "子会话 ID", messageID: "消息 ID" })
```

结果直接返回 messages，默认包含文字、可见推理和工具记录。
工具条目保留名称、ID、状态和错误摘要；details 中是参数、结果等详细信息。
长内容会缩短预览并标记 truncated，消息和工具条目仍然保留，可以按消息 ID 补读。
读取历史时，activity 仍表示当前活动。

| 可选参数 | 含义 |
| --- | --- |
| limit | 每页消息数，默认 20，最多 100 |
| maxChars | 单次正文预算，默认 12000，最多 40000；不包括条目身份和状态 |
| cursor | 官方历史分页游标；刷新最新记录时省略 |
| messageID | 读取指定消息，不能与 cursor 同时使用 |
| offset、revision | 消息详情返回 nextOffset 时，用 offset=nextOffset 和相同 revision 继续读 |

单条消息详情返回 JSON 文本 text，可将各段连接后解析。revision 用来识别正在变化的消息；变更后从头重读即可。
分页、消息读取和服务发现均复用官方 SDK。没有事件日志模式、后台轮询、缓存或额外模型调用。

## 状态含义

- execution.active：当前服务进程是否正在执行该会话。
- execution.lastOutcome：上次执行结果；与当前活动状态分开。
- activity：工具执行、推理、压缩、待授权等当前可见阶段。

inactive 不自动等于成功。普通工具失败也不自动等于整个任务失败。
只开放调用者自己的直接子任务，排除 fork。
子 agent 要在后台执行，主 agent 才能在它工作期间继续查询。

OpenCode 原有的后台完成通知保留。插件通过官方上下文 hook 允许主 agent 使用只读观察工具，不改写内置工具的执行或返回内容。
未被提供商暴露、或尚未被 OpenCode 保存的推理片段不可读取；查询也不是跨接口原子快照。

## 开发与验证

```sh
bun run check
bun run test:live
bun run test:live:scenarios
```

check 执行类型检查、行为测试和构建。
真实联调使用现有 OpenCode，在独立临时目录运行父子会话，先检查免费模型费用，不回退到付费模型。
test:live 覆盖模型主动查询、历史翻页、长消息续读及子会话无写入；报告位于 .test-artifacts/live-report.json。
test:live:scenarios 通过官方 SDK 同时运行四个真实子任务，覆盖长工具结果、工具报错恢复、中断和等待授权，并与原始消息逐条比对。
默认使用 mimo-v2.6-flash-free；可用 OBSERVER_TEST_MODEL 指定另一个已安装的零费用模型。场景报告保存在 .test-artifacts/scenarios-模型名.json。

实现使用 TypeScript、Bun、OpenCode 官方插件/客户端和 Zod，没有额外框架。

[实现说明](docs/implementation-plan.md) · [兼容性](docs/compatibility.md) · [验证记录](docs/testing.md)
