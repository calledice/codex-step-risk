# Codex Step Risk

版本 **0.4.1**。每个可观测步骤直接显示：**这一步留下的问题最终未消除，并影响任务失败的概率估计**。每步独立计算，不用排查占比替代概率，各步无需加总为 100%。

0.4.1 修复部分独立浏览器点击“AI 评估”时的本地 HTTP 403：页面使用服务端随机令牌校验请求，兼容同源请求的 Origin 端口丢失；仍拒绝异站来源和其他端口。升级后刷新页面即可，服务重启时页面会自动更新令牌并最多重试一次。

工具完成或子 agent 完成后立即生成本地估计；面板可调用 **GPT-6 Luna**，结合任务目标、步骤摘要与前序证据重新评估。Luna 失败时保留本地数值。显示数值不依赖校准，但预测准确性尚未经真实任务结果验证。

## 本地使用

需要 Node.js 22.19+ 和支持插件/hooks 的 Codex。从仓库根目录运行：

```powershell
codex plugin marketplace add .
codex plugin add codex-step-risk@codex-step-risk
npm run dashboard
```

打开 [本地面板](http://127.0.0.1:43147/)，选择会话，在“任务目标与 AI 设置”中填写目标/验收要求，然后逐步或批量点击“AI 评估概率”。启用“自动评估新步骤”后，只处理本次打开页面之后的新步骤；首次打开不会补跑历史。每批最多 10 步，调用串行，结果缓存到本机，刷新或服务重启不会重复调用相同证据。

默认数据目录是 `CODEX_HOME/codex-step-risk`（未配置 CODEX_HOME 时为 `~/.codex/codex-step-risk`）。可用 `STEP_RISK_DATA_DIR`、`STEP_RISK_DASHBOARD_PORT` 修改面板数据目录和端口。服务只监听回环地址。页面关闭后自动 AI 评估停止，hook 继续记录本地概率。

桌面聊天消息不会自动展示 hook 的 systemMessage，请保持面板标签页。安装后在 `/hooks` 检查是否已加载和信任。若插件内 hook 未被运行时加载，使用 [用户级 hook 兼容入口](docs/USER_HOOK_FALLBACK.md)。版本更新后同步更新兼容入口路径，可能需要重开会话或重启 Codex。

## 概率如何计算

采用三个顺次条件概率相乘：

`本步留下问题 × 已有问题时持续到任务结束 × 问题未消除时造成目标失败`

本地默认先验公开：成功步骤为 1.2%；未知结果为 4.5%；明确动作报错为 21%；操作性质未知而报错为 13.5%；读取或验证报错为 4.5%。这些是设计先验，不是实测频率。Bash/exec_command 名称本身不足以判断是在修改还是诊断。

Luna 返回三个因素、具体理由、引用和依据质量，由本地验证后相乘。每次仅使用本步及最多 6 个同回合前序步骤，不使用未来结果。后续无关步骤不会重写历史预测。修改目标或数据模式会使旧评估缓存失效。详细定义见 [模型说明](docs/MODEL.md) 与 [0.4.0 产品契约](docs/STEP_FAILURE_V04_SPEC.md)。

“观测成功/失败/未判定”与概率分别显示。退出码、错误标记、HTTP 状态等作为结构化观测；没有判据就展示响应，不靠关键词猜执行结果。本机部分 Bash hook 只提供 stdout，不含退出码，因此 `step-risk-fail` 文本本身不能证明退出 7。

## Luna 数据和配置

继续读取 `config.toml` 当前 `model_provider` 的 HTTPS `base_url`，并从其 `env_key` 对应环境变量取密钥。没有自定义提供方时使用 OpenAI Responses API 和 `OPENAI_API_KEY`。不复制密钥到插件、日志或 ZIP。

插件默认只发送结构化判据，自动评估默认关闭。每个会话可以改成“脱敏上下文摘要”，发送限长的目标（2000 字符）、动作（1200 字符）和响应（2000 字符）及前序摘要；过滤常见令牌、密码、私钥和本地路径。自然语言脱敏不能保证覆盖所有敏感信息；每张卡片可先预览实际 AI 输入。用户明确授权后可以在本机 `assessment-defaults.json` 设置 `dataMode` 和 `autoAssess` 默认值，这个文件不在插件包内。

没有可靠判据的完整响应存入本地 `logs/` 与 `events/`。默认不记录工具输入；开启摘要模式时仅记录脱敏的动作/响应摘要。不会读取完整 transcript 自动上传。请求使用 `store:false`，自定义提供方的处理行为以其实现为准。每次请求超时 15 秒，临时故障最多重试一次，失败原因在步骤卡片显示。

参考 [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) 与 [结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)。

## 开发与交付

```powershell
node --test
node --check plugins/codex-step-risk/assets/dashboard.js
```

验证记录见 [VALIDATION](docs/VALIDATION.md)。本地 ZIP 以插件根目录入包，不包含日志、任务设置、密钥或仓库开发文件。旧 `pCurrent`、`pResidual`、`taskFailureRisk` 等字段仅保留兼容，0.4.0 页面与新概率不使用这些权重。此前 [v2 校准研究设计](docs/STEP_RISK_V2_DESIGN.md) 是历史方案，不是当前数值显示的前置条件。
