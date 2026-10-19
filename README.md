# OpenCode Subagent Observer

让主 agent 主动查询子 agent 的当前状态和执行过程，查询对子 agent 无感。

已实现两个只读查询工具，并使用已安装的 OpenCode 与免费模型完成真实后台子任务联调。

## 约定

- 纯 pull：一次工具调用触发一次有限查询；轮询由主 agent 决定。
- 只读：不向子 agent 发消息，不修改子会话上下文，不启动或中断任务。
- 使用 OpenCode V2 官方插件 API 和生成的客户端，保持 OpenCode 源码不变。
- 复用现成 SDK、Schema 和工具链，仅编写查询编排与结果整形。
- “实时”指查询时服务端可读取的最新数据；不承诺获取未持久化的流式片段。

## 文档

- [实现方案](docs/implementation-plan.md)：架构、工具契约、状态语义、实现步骤和验收。
- [选型与接口核查](docs/compatibility.md)：官方来源、当前源码依据、版本约束和待验证项。
- [验证记录](docs/testing.md)：自动化测试、真实模型联调与已知限制。

## 开发与构建

技术栈：TypeScript / ESM、Bun、OpenCode 官方 Promise 插件 API、官方生成客户端、Zod Standard Schema。
当前开发工具为 Bun 1.4.3，依赖通过 bun.lock 固定。没有精确匹配 OpenCode 版本的运行时限制。

```sh
bun install --frozen-lockfile
bun run check
```

`check` 执行类型检查、行为测试和构建，产物为 `dist/index.js`。
无需启动独立插件服务，也不需要修改 OpenCode 源码。

## 在其他项目中加载

构建完成后，在目标项目现有的 `opencode.jsonc` 的 `plugins` 数组追加本地工程路径：

```json
{
  "plugins": [
    "/mnt/data/code/opencode-subagent-observer"
  ]
}
```

可配置形式见 [examples/opencode.jsonc](examples/opencode.jsonc)。
项目路径按实际存放位置调整；本仓库自己的 `.opencode/plugins/observer/index.ts` 已配置源码开发入口。
不要同时在同一项目重复配置源码入口和包入口。

默认使用官方 `Service.discover()` 连接已运行的本地 OpenCode 服务并取得认证信息。
插件不会启动、停止或替换服务。自定义服务可通过插件 options 设置 `baseUrl`、`headers` 和 `timeoutMs`。
远程地址必须指向宿主所在的同一个服务；每次查询会核对调用者身份。

OpenCode 在后台加载插件，初次查询插件列表时可能尚未显示；以实际 agent 请求能看到工具为准。

## 工具使用

`list_subagents({ limit?, cursor? })`：列出调用者的直接子任务，排除 fork；返回会话 ID、标题、agent/model、活动状态和上次执行结果。

`inspect_subagent({ sessionID, view?, include?, limit?, maxChars?, afterSeq? })`：

| 参数 | 默认值 / 含义 |
| --- | --- |
| `view` | `snapshot`；也可用 `changes` |
| `include` | `["messages", "tools"]`；可加入 `reasoning` |
| `limit` | 20，上限 100 |
| `maxChars` | 12000，上限 40000；限制详细过程的数据预算，不包括状态元数据 |
| `afterSeq` | changes 模式的排他水位，下一次传入上次返回的 nextAfterSeq |

例如：

```json
{
  "sessionID": "子会话 ID",
  "view": "snapshot",
  "include": ["messages", "reasoning", "tools"]
}
```

查询目标必须属于当前调用者。查询不会触发子 agent 的模型调用或改变它的消息、上下文与执行控制。
轮询频率和如何利用结果由主 agent 决定；插件不会在主 agent 停止后主动唤醒它。
后台 subagent 的原生完成通知仍由 OpenCode 保留。

## 可见性与宿主差异

- `execution.active` 与 `execution.lastOutcome` 分开表达，inactive 不等于任务完成。
- reasoning 只包括模型提供商已经暴露并由 OpenCode 保存的文本；未结束的流片段不可读。
- snapshot 返回最近的投影消息；重新查询可以看到同一消息中更新的工具状态。
- changes 尝试有限读取官方持久日志，不订阅后续事件。
- 若宿主只返回日志序号而不返回事件正文，结果明确标注 `historyUnavailable: true`，同时返回当前 `snapshot` 与更新后的水位。这不能重建两次轮询间的所有中间事件。
- 文本裁剪会显式标记 `truncated`；没有额外 LLM 摘要和摘要费用。

## 真实联调

```sh
bun run test:live
```

脚本使用现有服务，在临时目录创建独立父子会话，调用可用的零费用模型 `opencode/mimo-v2.6-flash-free`。
先检查模型费用；不可用时失败，不回退到付费模型。
主 agent 调用观察工具；子 agent 执行等待和读取 README 的任务。测试结束后比较子会话消息与持久日志，验证观察没有写入。
报告保存在 `.test-artifacts/live-report.json`。测试会话保留以便检查，不改动已有用户会话。
