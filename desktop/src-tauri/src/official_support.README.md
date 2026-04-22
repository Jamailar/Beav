# `official_support.rs`

官方平台与多提供商模型支持模块。

- 官方登录态、鉴权、会话状态辅助。
- OpenAI-compatible / Anthropic / Gemini 模型列表拉取。
- 多协议统一聊天请求调用。
- 登录态生命周期由 `commands/official.rs` 负责：
  - app setup 时执行 bootstrap
  - 前台唤醒与后台守护都会复用同一条会话恢复链路
  - 受保护请求统一走“预刷新 -> 401 后刷新并重试一次 -> 失败清会话”
  - refresh 使用全局单飞锁，避免并发刷新把 token 覆盖乱掉
