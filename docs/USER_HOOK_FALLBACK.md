# 用户级 hook 兼容接入

当插件已启用，但 Codex `/hooks` 显示 `PostToolUse Installed 0` 时，可用 Codex 的用户级 hook 源调用同一评分脚本。此方式已在 Windows Codex CLI 0.162.0-alpha.2 上验证。

将以下 JSON 中的脚本路径换成已安装插件缓存目录里 `scripts/user-hook.mjs` 的绝对路径，保存到 `~/.codex/hooks.json`。若该文件已存在，合并三个事件条目，不要覆盖其他 hook。Windows JSON 路径里的反斜杠须写成 `\\`；命令从 `node` 开始，脚本路径加双引号。

```json
{
  "hooks": {
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node \"C:\\path\\to\\codex-step-risk\\scripts\\user-hook.mjs\"", "timeout": 8 }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "node \"C:\\path\\to\\codex-step-risk\\scripts\\user-hook.mjs\"", "timeout": 8 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"C:\\path\\to\\codex-step-risk\\scripts\\user-hook.mjs\"", "timeout": 8 }] }]
  }
}
```

重新启动 Codex CLI，在 `/hooks` 中确认三个事件各有一个待审查 hook，核对命令路径后信任。新任务中执行工具时，消息以 `[codex-step-risk] event` 开头；turn 结束时会有摘要。日志写入 `CODEX_HOME/codex-step-risk/logs/`，其中 `CODEX_HOME` 未设置时使用用户主目录下的 `.codex`。0.3.0 起，无法判定成功或失败的事件会把完整响应保存在本地 `logs/` 和 `events/`；这些内容可能敏感。

此接入按用户配置全局生效；插件内 hook 若在未来 Codex 版本恢复加载，应移除这些用户级条目以避免重复消息。插件缓存版本更新后，也要把命令路径更新到新版本，并重新审查信任。
