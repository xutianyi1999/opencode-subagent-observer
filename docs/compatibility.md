# 兼容性记录

本次验证环境：OpenCode 2.0.32、Bun 1.4.3、官方 plugin/client 2.0.32、Zod 4.1.8。
依赖锁定用于复现构建，没有精确宿主版本门禁。未对其他版本作全面兼容保证。

## 已验证的接入方式

- 本地源码入口：.opencode/plugins/observer/index.ts。
- 项目配置加载本工程目录，根目录 server.js 导出构建后的插件。
- 默认连接已有本地服务，官方 Service 负责发现和认证。
- 可用 options.baseUrl 与 options.headers 指定同一宿主的自定义连接。
- 插件初始化是异步的，刚建立位置时 plugin.list 可能尚未显示全部插件。
- 工具声明输入和输出 Schema，通过官方 Promise API 注册。

## 实现选择

当前 Plugin Context 没有完整的会话列表和消息分页能力，因此使用官方客户端。
过去尝试过持久事件增量，但它对本需求收益有限，还引入宿主差异与退化分支，已整体移除。
现在只依赖会话与消息读取接口，不需要事件正文或日志水位。

过去对内置 subagent 返回文字的替换也已移除，改用官方上下文 hook 设置主 agent 的只读观察政策。
插件不包装内置工具执行器，不依赖内置提示文案的精确字符串。

消息、推理和工具详情以实际宿主保存并暴露的数据为准。未保存的临时流片段不可读取。

## 官方资料

- [V2 插件](https://opencode.ai/v2/docs/build/plugins/)
- [V2 JavaScript 客户端](https://opencode.ai/v2/docs/build/client/)
- [Bun 文档](https://bun.sh/docs)

旁边 OpenCode 源码目录未修改。真实测试连接原有后台服务，在独立测试会话中进行。
