# Registry

这里存放市场索引，不存放具体素材实现。

客户端推荐读取顺序：

1. `index.json`
2. `kinds/<kind>.json`
3. 定位到 `packages/` 下的真实包

原则：

- `registry/` 是“可安装白名单”
- `packages/` 是“实际内容”
