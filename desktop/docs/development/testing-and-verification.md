# Testing And Verification

Status: Current

## Goal

本仓库自动化测试还不完整，因此每次改动必须附带最小可执行验证。

## Baseline

```bash
pnpm build
cd src-tauri && cargo fmt --check && cargo check
```

## By Change Type

- 页面/UI：
  - 打开对应页面
  - 验证切换、刷新、错误回退
  - 验证旧数据不会因刷新被清空
- IPC / bridge：
  - 从页面或控制台触发一次真实调用
  - 验证 timeout/fallback/normalize
- runtime / events：
  - 发起一次真实对话或任务
  - 验证流式文本、工具、done 事件
- workspace / persistence：
  - 验证当前窗口立即可见
  - 验证重启后可恢复
- video / remotion：
  - 验证素材路径转换
  - 验证预览或导出至少一条路径

## Evidence

文档和提交说明中应至少说明：

- 运行了哪些命令
- 手动验证了哪个页面或流程
- 没有验证的部分是什么，以及为什么
