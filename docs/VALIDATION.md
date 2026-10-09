# 验证记录

日期：2026-10-09。开发环境：Codex CLI 0.162.0-alpha.2、Node.js 24.14.1、Windows。

## 完成的检查

- `node --test`：11 项通过。覆盖概率质量守恒、一万事件的有界候选、迟到结构化错误、角色先验、事件去重、turn 隔离、工具和子 agent 元数据提取、私密正文不进入日志、8 个进程并发更新。
- 三个脚本通过 `node --check`；`package.json`、插件 `plugin.json`、`hooks.json`、marketplace JSON 均可解析。
- 对照 [官方插件打包文档](https://developers.openai.com/plugins/build/plugins) 核对 portable manifest、`extensions.com.openai.hooks` 与 marketplace 源路径；对照 [官方 Hooks 文档](https://developers.openai.com/codex/hooks) 核对 `PostToolUse`、`SubagentStop`、`Stop` 的输入与 JSON 输出。
- 进程测试实际从 stdin 发送合成 Codex hook JSON，并读取 stdout 消息、`PLUGIN_DATA` 状态文件和 JSONL。

## 尚需试装确认

安装到真实 Codex host 后，需要审查并信任 hook，再运行一个实际工具任务，确认 host 的 `PLUGIN_ROOT` 路径展开、`systemMessage` 展示和实际 `tool_response` 形状。模型参数尚无 Codex 原生成功/失败与人工责任样本校准，始终输出 `experimental_uncalibrated`。
