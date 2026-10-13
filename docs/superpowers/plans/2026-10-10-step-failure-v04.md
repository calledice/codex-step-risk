# Step Failure 0.4.0 Implementation Plan

> **For agentic workers:** Use the available collaboration tools for disjoint implementation tasks and independent review. The named superpowers execution sub-skills are not installed; this session implements the authorized plan directly.

**Goal:** 每个可观测步骤立即显示它最终导致任务失败的独立概率估计，并支持脱敏上下文 Luna 评估。

**Architecture:** 纯概率模块提供确定性规则估计；hook 记录快照，dashboard 重算旧日志。脱敏 evidence、Luna 三因素评估和持久化缓存位于本地面板服务；前端使用步骤卡片呈现。

**Tech Stack:** Node.js >=22.19.0，原生模块、node:test、无前端框架、Responses API。

## Global Constraints

- 以 docs/STEP_FAILURE_V04_SPEC.md 的 AC-1 至 AC-8 为验收约定。
- 不用 pCurrent、pResidual 或 taskFailureRisk 推导新百分数。
- 不自动发送完整日志；ZIP 不含用户设置或密钥。
- 保留现有工作区改动；不提交或推送未经请求的 Git 变更。

## Task 1: 独立每步概率模块

Files: `scripts/step-probability.mjs`, `test/step-probability.test.mjs`（scripts 均位于插件根目录）。

Interface: `estimateStepFailure(event)` 输出约定的 StepFailure；`composeStepFailure(factors, details)` 检查范围并计算乘积。

- [x] 添加未知/成功/错误、诊断步骤、无归一化和非法因素的行为测试，执行并确认缺少新行为。
- [x] 实现条件链、版本化默认先验、可读原因和限制；不引入依赖于其他步骤总数的权重。
- [x] 运行 `node --test test/step-probability.test.mjs`，预期全部通过。

## Task 2: 脱敏上下文与模型评估

Files: `scripts/assessment-context.mjs`, `scripts/luna-assess.mjs`, 相关测试；必要时抽取 `luna-explain.mjs` 的通用请求函数并保持旧接口。

Interfaces: `summarizeStepContext({toolName,toolInput,response})`; `buildAssessmentEvidence(event, previousEvents, settings)`; `assessWithLuna(evidence, connection)`。

- [x] 先测试密钥过滤、长度边界、仅结构化模式不发送正文、前序窗口、因素/证据引用校验。
- [x] 实现三因素 JSON schema、固定预测语义、模型错误处理和失败回退契约。
- [x] 运行对应测试与原有 Luna 测试，确认隐私和错误分类兼容。

## Task 3: 服务、缓存和采集整合

Files: `scripts/assessment-store.mjs`, `features.mjs`, `journal.mjs`, `hook.mjs`, `dashboard-data.mjs`, `dashboard-server.mjs` 及相关测试。

- [x] 为旧日志重算、缓存跨重启、目标变更失效、API Origin 与非法请求添加边界测试。
- [x] 接入每步规则估计、脱敏步骤摘要、本地会话设置和按证据哈希缓存；同证据并发请求合并。
- [x] API 只从服务端日志选择事件；客户端不能注入模型证据。保留先有的失败隔离，网络不进入 hook。
- [x] 验证原有重复、并发、恢复测试；运行 `node --test`。

## Task 4: 面板

Files: `assets/dashboard.html`, `assets/dashboard.css`, `assets/dashboard.js`。

- [x] 将主展示改成有百分数的步骤卡片，提供因素、证据、预测来源以及目标和数据模式设置。
- [x] 对 `/api/assess` 串行排队；历史批量最多 10 项，自动模式只处理打开后新出现的步骤；刷新复用服务端缓存。
- [x] 用真实渲染验证窄侧栏无横向表格、旧未知步骤有概率、Luna 成功和失败降级均可见。

## Task 5: 交付

- [x] 独立审查核心概率语义、网络数据和页面流程，修复有证据的问题。
- [x] 更新版本、PRODUCT_SPEC、MODEL、README、VALIDATION 与技能文案。
- [x] 更新本机 0.4.0 安装及用户级 hook；核对缓存文件；重启 43147/43148 并复测真实目标步骤。
- [x] 将插件根目录打包为 `codex-step-risk-0.4.0-local.zip`，逐项比对源码字节并检查密钥未入包。

## Completion evidence

Implementation, independent review, 77 tests, live Luna/API/UI verification, local installation and ZIP are complete. See docs/VALIDATION.md for exact results and limits. The current desktop session has not shown a new 0.4.0 hook event after its command path changed; user restart/reopen and hook trust verification remain necessary. The requested 420 px viewport was not actually applied by the host, so responsive evidence is limited to actual widths 749 and 1265 px.
