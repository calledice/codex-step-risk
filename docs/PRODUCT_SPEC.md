# Codex Step Risk 产品约定

版本：0.1.0 试用版（2026-10-09）

## 目标与边界

把现有实时贝叶斯归因原型适配为可从 GitHub marketplace 安装的 Codex 插件。每次支持的工具调用结束后，根据结构化错误信号和工具/子 agent 角色，更新当前可观测步骤的责任质量；子 agent 结束时记录可识别的 agent 候选；当前 turn 结束时给出摘要。不重放工具或模型，不预先指定步骤总数，不改变工具输入、输出或执行决策。

Codex Hooks 提供 `PostToolUse` 和 `SubagentStop`，但没有稳定的每次模型内部推理步骤结束事件。这里的“步骤”明确指**可观测工具结果或子 agent 结束事件**。`PostToolUse` 的公共字段包含 `session_id`、`turn_id`、`tool_name`、`tool_use_id`、`tool_response`，不保证子 agent ID；因此普通工具候选不能可靠归属到某个子 agent。`SubagentStop` 自带 `agent_id` 和 `agent_type`，可单独定位该 agent 结束边界。

## 概率语义

`pCurrent` 是模型在当前 turn 的已见可观测边界和残余质量之间分配给本事件的归一化权重。它以“任务最终失败，且决定性责任点属于本 turn 的可观测边界或模型残余集合”为条件。残余质量涵盖未来事件、不可观测推理步骤、其他 turn 及未建模故障域。该值不是任务失败率、已校准频率或因果证明。每条输出固定标记 `experimental_uncalibrated`。

## 用户体验

- 通过 `codex plugin marketplace add calledice/codex-step-risk --ref v0.1.0` 加入来源，再用 `codex plugin add codex-step-risk@codex-step-risk` 安装。
- 插件的 `PostToolUse` hook 自动写入 `PLUGIN_DATA/predictions.jsonl`，并用简短 `systemMessage` 显示当前事件估计；`Stop` 显示本 turn 的 Top 候选。
- 必须由用户在 Codex `/hooks` 中审查并信任该插件 hook，之后才会执行。
- 原始 prompt、工具参数、模型正文、工具输出正文和错误消息均不写入预测日志。只保存结构化状态、事件 ID、工具名、角色与证据码。

## 技术路线

1. 纯 JavaScript 模型每个 turn 保留 future/residual 质量、最多 128 个候选与被压缩的历史质量。新事件按架构角色调整 hazard，按结构化错误信号乘似然比，再归一化。
2. `PostToolUse` 只检查 `tool_response` 的显式 `isError` / `is_error` / 非零退出码等字段；不做正文关键字搜索。`SubagentStop` 只读 `agent_id`、`agent_type`，不读取 `last_assistant_message`。
3. 每次 hook 都是短命进程；在 `PLUGIN_DATA` 下按 session/turn 存持久状态，使用原子锁与原子文件替换处理并发，失败时不阻断 Codex。
4. 根 `plugin.json` 使用 Agent Plugins schema；`extensions.com.openai.hooks` 指向插件目录中的 hook 配置；`.agents/plugins/marketplace.json` 供 GitHub marketplace 安装。另附一个 `skills/step-risk/SKILL.md` 说明如何解释日志。

## 验收

- marketplace 和插件清单可解析，hook 脚本在 Windows 的 Codex CLI 环境能启动。
- 观测到的工具结果立即产生一条带概率质量与校准标记的预测；无预设长度，长期运行内存按候选上限有界。
- 结构化错误提升当前候选，角色改变先验，多个 turn 隔离，并发更新不丢失。
- 插件不读取或记录原文，不改变 agent/tool 控制流；真实 Codex hook 信任与显示行为在试装环境中验证。
- 发布到 `calledice/codex-step-risk`，文档明确说明可观测性与概率边界。
