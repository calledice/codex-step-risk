# 模型说明

## 观测对象

Codex Hooks 在本地运行中可提供 `PostToolUse`、`SubagentStop`、`Stop`。本插件的一个候选事件是工具完成或子 agent 结束。内部推理、未走本地函数 hook 的 hosted tools、工具调用前的隐藏状态和最终答案正文不在观测范围内。普通工具 hook 没有可靠的 `agent_id` 字段，因此这类候选的 `actor` 为 `unknown_agent`。

模型在 `session_id + turn_id` 范围内维护条件质量。`pCurrent` 可以写作近似的

`P(C=e_t | O_1...O_t, 最终失败, 责任落在本 turn 的可观测/残余空间, M)`。

`C` 是模型设定的单个责任位置，`M` 是下述参数假设。输出固定为 `experimental_uncalibrated`；既无成功样本标定，也没有反事实重放来证明决定性责任。

## 在线更新

初始把质量 1 放在 `pResidual`。到达新事件时：

1. 把历史候选及压缩历史的 `recoveryHazard=0.02` 部分移回残余质量。它粗略表示后续恢复与责任位置改判；不等同于 verifier 的因果责任转移。
2. 用 `h_t = sigmoid(logit(baseHazard) + roleOffset)` 从残余质量分给当前事件。`baseHazard=0.03`。
3. 当前质量乘证据似然比：`tool_error=8`，`no_hard_signal=0.25`。
4. 对当前、保留历史、压缩历史和残余质量归一化。最多保留 128 个具体候选；多出的最低权重历史候选合入 `pOtherPast`。输出 Top-3。

默认角色偏移位于 log-odds 空间：`planner=0.15`、`executor=0.20`、`verifier=0`、`other=0`。工具名用于粗分类：计划/委派操作偏向 planner，执行与编辑工具偏向 executor，审查类工具偏向 verifier。`SubagentStop.agent_type` 也可映射角色。角色识别只是弱先验，不代表该 agent 实际有责。

每次 hook 是短命进程，状态保存在 `PLUGIN_DATA/state/<session-hash>.json`。同一个 session 的新 turn 重置候选，旧结果仍留在 `PLUGIN_DATA/logs/<session-hash>.jsonl`。原子目录锁避免并发写入丢事件；hook 失败时向 Codex 返回空 JSON，不改变工具运行。

## 解释限制

`pCurrent` 是**模型内归一化质量**，不能解释为“此类事件历史上有同样比例真的有责”。`pResidual` 不是精确的未来步骤概率，它还覆盖不可观测的模型步骤、其他 turn 和未建模故障。多个条件相关错误标记没有联合似然模型；只用一个结构化错误码，避免重复计分。

任务最终成功时，失败条件不成立，先前预测应视为在线诊断信号而非真实责任概率。对失败任务，也必须结合人工判责。正式校准需要 Codex 原生完整任务结果、人工责任位置、各边界预测快照，并按任务分组切分数据，报告 Top-1/Top-3、Brier 分数和可靠性图。
