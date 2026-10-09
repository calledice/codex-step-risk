# Codex Step Risk

Codex 插件试用版：在支持的 `PostToolUse` 工具结果和 `SubagentStop` 子 agent 结束事件之后，立即估计“当前可观测事件最终被认定为责任点”的模型权重，并在 turn 结束时列出最可疑候选。不重放环境，也不需要预先知道步骤总数。

**0.1.0 是未校准的实验模型。** `pCurrent` 以任务最终失败、且决定性责任点落在本 turn 可观测边界或残余集合为条件；它不是任务最终失败率、历史频率或因果证明。Codex 没有向插件提供每次内部推理步骤的稳定结束事件，因此这版只覆盖支持 hook 的工具与子 agent 边界。

## 安装

需要支持插件与 Hooks 的本地 Codex，以及 Node.js 22.19+。在 Codex CLI 中运行：

```sh
codex plugin marketplace add calledice/codex-step-risk --ref v0.1.0
codex plugin add codex-step-risk@codex-step-risk
```

重启 Codex 或开启新任务。在 CLI 中使用 `/hooks` 审查并信任 `codex-step-risk` 的三个 hook；未信任时它们会被跳过。桌面版可在 Plugins 目录找到该 marketplace 的插件并安装；安装后同样需要审查 hook 信任状态。查看安装状态：`codex plugin list`。

删除插件：`codex plugin remove codex-step-risk@codex-step-risk`。

官方文档：[插件打包](https://developers.openai.com/plugins/build/plugins)、[Hooks](https://developers.openai.com/codex/hooks)。

## 试用方式

发起一个会调用本地工具的 Codex 任务。每个支持的工具结束后，插件用 `systemMessage` 显示简短消息，例如：

```text
[codex-step-risk] event #7 Bash: current=18.4%, residual=35.1% (experimental_uncalibrated)
```

`Stop` 时显示本 turn 的最高候选，并给出 JSONL 日志路径。完整快照写在 Codex 分配的 `PLUGIN_DATA/logs/<session-hash>.jsonl`。同一 session 每个 turn 的状态独立，旧 turn 的预测日志仍在同一个 JSONL 中。

输出字段包括 `sessionId`、`turnId`、`ordinal`、`eventId`、`role`、`actor`、`evidenceCodes`、`priorHazard`、`pCurrent`、`pResidual`、`pOtherPast` 和 `topCandidates`。`pRetained + pOtherPast + pResidual = 1`。`pResidual` 包括尚未出现的事件和不可观测步骤；它不能被当作“后面的某一步一定有错”。

`actor=unknown_agent` 表示 Codex 的普通工具 hook 没提供可靠的子 agent ID。`SubagentStop` 可以输出 `subagent:<agent_id>`，但它是子 agent 的结束边界，不能倒推出它内部哪次推理或工具调用负责。

## 信号与隐私

只使用 `tool_response` 中显式的 `isError`、`is_error`、非零 `exit_code` / `exitCode` 或失败 `status`。工具输出正文即使包含 “error” 字样，也不会被扫描。没有结构化错误标记时采用弱负证据；这不代表该步正确。

插件不记录 prompt、工具输入、工具响应正文、子 agent 最后消息或 transcript 路径。它只记录定位 ID、工具名、角色、有限证据码和模型质量。插件返回的消息仅用于提示，不阻断、批准、改写或重试工具。并发事件由短锁串行写入；状态最多保留 128 个精确候选，低质量历史候选合并到 `pOtherPast`。

更多细节见 [模型说明](docs/MODEL.md)、[产品约定](docs/PRODUCT_SPEC.md) 和 [验证记录](docs/VALIDATION.md)。

## 开发验证

```sh
node --test
node --check plugins/codex-step-risk/scripts/hook.mjs
```

当前模型参数是专家设定值。先前另一套系统的人工标注与 Codex 可观测边界不等价，也缺少 Codex 原生成功任务，因此未用于校准。试用时应保存任务结果及人工责任标注，再按任务分组评价 Top-K 命中率与概率校准。
