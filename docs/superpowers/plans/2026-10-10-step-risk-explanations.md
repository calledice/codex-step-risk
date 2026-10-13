# Step Risk 指标与 Luna 解读 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让面板用明确的排查顺序代替容易误读的“排查占比”，并提供只发送结构化判据与指标的手动 Luna 解读。

**Architecture:** 现有 `model.mjs` 的条件权重和 `risk.mjs` 的规则风险保持原值。页面把条件权重放进技术细节，优先显示候选顺序和未覆盖范围；服务端从本地事件白名单构造 Luna 输入，绝不传送响应正文、会话 ID、工具参数或日志路径。面板复用用户级 `config.toml` 当前提供方的 `base_url` 与 `env_key`，只从环境读取密钥。Luna 只解释已有判据，不回写事件结果或模型权重。

**Tech Stack:** Node.js 22.19+、原生 HTTP/fetch、浏览器原生 JavaScript、OpenAI Responses API `gpt-6-luna` 与 `text.format` JSON Schema。

## Global Constraints

- 完整未知响应仅保存在本地 `logs/` 与 `events/`。
- Luna 调用只能由页面上的明确点击触发；输入只有白名单结构化判据和指标。
- `taskFailureRisk` 是假设驱动、未校准的规则模型值；条件权重不得称为真实失败率、步骤重要性或因果概率。
- 无 `OPENAI_API_KEY`、API 失败或模型拒答时，原始判据与页面仍可用。

---

### Task 1: 明确指标语义并调整面板

**Files:**
- Modify: `plugins/codex-step-risk/assets/dashboard.html`
- Modify: `plugins/codex-step-risk/assets/dashboard.js`
- Modify: `plugins/codex-step-risk/assets/dashboard.css`
- Modify: `docs/MODEL.md`

**Interfaces:** Consumes existing `latest.topCandidates`, `latest.pCurrent`, `latest.pResidual`, `latest.taskFailureRisk`; produces DOM cards for排查顺序、未覆盖范围、观测结果和可展开技术权重。

- [x] **Step 1:** 在页面文案中写明“排查顺序不是重要程度或出错概率”，并把 `pCurrent`/`pResidual` 数值移到 `<details>` 的模型技术数据区。
- [x] **Step 2:** 用 `latest.topCandidates` 给最新事件显示 `第 N 位` 或 `未进前 3`；候选列表仅显示顺序和事件，不把条件权重当作对用户的主指标。
- [x] **Step 3:** 删除步骤表的“排查占比”列，保留观测结果和原始判断依据；`node --check plugins/codex-step-risk/assets/dashboard.js` 应通过。

### Task 2: 元数据限定的 Luna 解读

**Files:**
- Create: `plugins/codex-step-risk/scripts/luna-explain.mjs`
- Modify: `plugins/codex-step-risk/scripts/dashboard-server.mjs`
- Modify: `plugins/codex-step-risk/assets/dashboard.js`
- Test: `test/luna-explain.test.mjs`
- Modify: `test/dashboard.test.mjs`

**Interfaces:** `buildLunaEvidence(event)` 返回仅含 `kind`, `role`, `toolName`, `outcome`, `signals`, `taskFailureRisk`, `pCurrent`, `pResidual` 的新对象；`explainWithLuna(event, {apiKey, fetchImpl})` 返回 `{summary, basis, limits}`。`POST /api/explain` 接受 `{sessionId, turnId, ordinal}`，从本地日志选择事件后调用解释器；同源校验、请求体上限和超时由服务端执行。

- [x] **Step 1:** 测试 `buildLunaEvidence`：在响应、会话 ID、事件 ID 和状态文本里放入私密哨兵，断言 API 输入不含哨兵；断言退出码与布尔判据仍被保留。
- [x] **Step 2:** 测试 Luna 请求固定使用 `gpt-6-luna`、`store:false`、`text.format` JSON Schema；模拟 API 成功、拒答、超时和缺少 API key。
- [x] **Step 3:** 实现白名单构造与 `fetch` 调用，仅解析模型结构化文字；不修改 `outcome`、`taskFailureRisk` 或 `pCurrent`。
- [x] **Step 4:** 测试并实现同源 `POST /api/explain`；拒绝跨站请求、非法事件 ID、超限请求体，错误只返回通用信息。
- [x] **Step 5:** 页面每行提供“Luna 解读”按钮；点击才发请求，结果标记“AI 解释，不参与判定”，自动刷新后保留当前解释。

### Task 3: 验证与交付

**Files:**
- Modify: `README.md`
- Modify: `docs/VALIDATION.md`
- Update: `codex-step-risk-0.3.0-local.zip` only if a new ZIP is explicitly needed; otherwise mark the old ZIP as prior build.

- [x] **Step 1:** 运行 `node --test`、相关 `node --check`、JSON 清单解析和 `git diff --check`。
- [x] **Step 2:** 用合成事件调用 Luna 一次，确认输出能解释依据、承认未知结果，且请求里没有响应正文。改用 `config.toml` 选中的提供方地址及其密钥变量后，真实调用已返回结构化解释；此前向 OpenAI 官方地址发送自定义提供方密钥导致的 401 已定位。
- [x] **Step 3:** 核对本地页面返回新版 HTML/JS，记录桌面浏览器可见性限制；更新说明和验证记录。

## Self-review

- 覆盖了术语、剩余权重的百分数、Luna 解读、输入边界、手动触发、失败降级和验证。
- 数据接口不含原始响应；模型输出与原判定分离。
