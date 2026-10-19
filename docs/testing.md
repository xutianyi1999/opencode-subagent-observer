# 验证记录

环境：已安装的 OpenCode 2.0.32、Bun 1.4.3。

## 自动化检查

bun run check：类型检查、21 项行为测试和构建。
测试使用真实官方客户端与本地 HTTP fixture，不使用全局 fetch mock。
已删除随事件增量模式退役的测试，保留实际需求的行为验证：

- 直接子任务与 fork 筛选、分页所有权。
- 当前活动与上次结果分离，失败、等待权限、压缩状态。
- 消息、推理、工具详情和无正文错误保留。
- 长推理不挤掉工具身份、错误或其他消息条目。
- 历史翻页不改变当前状态，完整消息可分段恢复。
- 变化中的消息不会跨 revision 拼接。
- 请求取消、目标归属及参数冲突。
- context hook 添加主 agent 的查询政策，不修改工具定义；普通子 agent 不接收该政策。

## 真实模型联调

bun run test:live 使用现有后台服务，在独立临时目录创建父子会话。
默认模型为 opencode/mimo-v2.6-flash-free，测试前检查费用为零，不回退到付费模型。
可通过 OBSERVER_TEST_MODEL 指定其他已安装的零费用模型。

主 agent 列出子任务、派发后台 general 子 agent，然后主动查询、翻历史、按消息 ID 读取并分段续读。
子 agent 只等待后读取 README 并总结，不接收配合观察的提示。

测试检查观察工具均执行成功。子任务完成后再次查询，比较前后的消息、会话元数据与费用，确认没有查询写入或新增模型执行。
测试会话保留以便检查，报告在 .test-artifacts/live-report.json。
不全局重载配置，不替换已有服务，不修改已有用户会话。

## 并行场景实测

```sh
bun run test:live:scenarios
OBSERVER_TEST_MODEL=deepseek-v4.1-flash-free bun run test:live:scenarios
OBSERVER_TEST_MODEL=deepseek-v4.1-flash-free bun run test:live
```

test:live:scenarios 用官方 SDK 在独立临时目录创建父会话和四个真实 general 子会话，并行执行以下任务。主会话不执行模型调用；检查程序调用与插件相同的只读查询实现。模型是否能使用插件工具由 test:live 单独验证。

- 读取含中文和 emoji 的长文件，产生长工具结果。
- 读取缺失文件产生真实工具错误，再读取正常文件恢复。
- 执行 sleep，查询到工具运行后中断，检查 interrupted 与工具错误。
- shell 配置 ask 权限，确认 waiting_permission、请求归属及一次授权后的恢复。

检查子任务列表与全部消息分页没有漏项或重复；256 字符预览保留全部工具的身份与状态。
逐消息分段恢复 JSON，与原始消息逐项比对文字、可见推理、全部工具参数和结果。
真实执行中读取消息后再中断，确认旧 revision 无法继续拼接。
查询结束后比对会话和消息完全不变，并确认各子任务费用为 0。
另检查不相关会话、父会话和 fork 被拒绝，跨会话消息 cursor 不会泄露其他会话记录。

本轮在已安装的 OpenCode 2.0.32 上使用 mimo-v2.6-flash-free 与 deepseek-v4.1-flash-free 完成场景实测。
报告保存在 .test-artifacts/scenarios-模型名.json，包含会话 ID、观察到的阶段、工具状态变化和比对统计。

正常执行、工具报错、中断和等待权限已有真实覆盖；provider 失败重试尚未真实触发，自动压缩仍主要由可控传输测试覆盖，不声称所有异常均已实测。
