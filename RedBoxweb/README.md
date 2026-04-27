# RedBoxweb

RedBoxweb 是 RedBox 的官网。下载页支持把最新 GitHub Release 里的桌面端安装包镜像到 OSS，同时从同一个 GitHub 版本里的 `Plugin/` 目录打包浏览器插件，并同步 GitHub Releases 里的更新日志，然后让 `/download` 页面从 OSS/CDN 下载，而不是直接走 GitHub 下载链接。

## 安装包 OSS 镜像同步

同步流程：

1. 从 `GITHUB_OWNER/GITHUB_REPO` 读取最新稳定版 GitHub Release。
2. 只选择 `.dmg`、`.zip`、`.exe` 安装包资产。
3. 跳过更新器元数据，例如 `latest.yml`、`latest-mac.yml`、`.blockmap`。
4. 把安装包上传到 OSS 的 `releases/<tag>/<filename>`。
5. 读取同一个 GitHub ref 下的 `Plugin/` 目录，把所有插件文件打成 `redbox-browser-plugin-<tag>.zip`。
6. 把插件压缩包上传到 OSS 的 `plugins/<tag>/redbox-browser-plugin-<tag>.zip`。
7. 分页读取 GitHub Releases，提取所有非 draft、非 prerelease 的 release notes。
8. 全部安装包和插件压缩包上传成功后，再写入 `manifests/latest.json`。
9. 如果最新 tag 没变，但 GitHub 上的更新日志变了，只重写 `manifests/latest.json`，不重复上传安装包和插件。
10. `/download` 页面读取 `OSS_PUBLIC_BASE_URL/manifests/latest.json`，把安装包和插件下载按钮指向 manifest 里的 `publicUrl`。
11. `/changelog` 页面读取同一个 manifest，展示 `releaseNotes` 里的历史更新日志。

### 环境变量

部署 RedBoxweb 时需要配置：

| 变量 | 是否必填 | 作用 |
| --- | --- | --- |
| `GITHUB_OWNER` | 是 | GitHub Release 所属账号，通常是 `Jamailar`。 |
| `GITHUB_REPO` | 是 | GitHub Release 仓库，通常是 `RedBox`。 |
| `GITHUB_TOKEN` | 否 | 可选 GitHub token。用于提高 API 限额，或读取私有 release。 |
| `OSS_REGION` | 是 | 阿里云 OSS region，例如 `oss-cn-hangzhou`。 |
| `OSS_BUCKET` | 是 | 存放安装包和 manifest 的 OSS bucket。 |
| `OSS_ACCESS_KEY_ID` | 是 | 有 OSS 写入权限的 access key id。 |
| `OSS_ACCESS_KEY_SECRET` | 是 | OSS access key secret，只能放在服务端环境变量里。 |
| `OSS_PUBLIC_BASE_URL` | 是 | OSS bucket 或 CDN 的公开访问根地址，例如 `https://downloads.example.com`。 |
| `SYNC_AUTH_TOKEN` | 是 | 内部手动同步接口的 Bearer token，建议使用足够长的随机值。 |
| `REDBOX_API_BASE_URL` | 否 | RedBox 官方账号 API 根域名。默认使用和桌面端一致的 `https://api.ziz.hk`。 |
| `REDBOX_APP_SLUG` | 否 | RedBox 账号 API 应用路径，默认 `redbox`，最终会请求 `/redbox/v1/...`。 |

下载页只需要 `OSS_PUBLIC_BASE_URL` 读取公开 manifest；真正执行同步任务时，需要上面所有必填同步变量。

账号页的微信扫码登录不需要额外配置即可连接默认 RedBox 官方 API；只有在部署私有账号服务时才需要覆盖 `REDBOX_API_BASE_URL` 和 `REDBOX_APP_SLUG`。

### 手动同步

设置好环境变量后，在 `RedBoxweb/` 目录执行：

```bash
pnpm sync:release
```

脚本会输出 JSON 结果：

- `status: "synced"`：发现新 release，并已镜像到 OSS。
- `status: "synced"`：最新 release tag 没变，但 GitHub release notes 有变化，并已更新 manifest。
- `status: "synced"`：最新 release tag 没变，但旧 manifest 里还没有插件镜像信息，并已补齐插件压缩包。
- `status: "skipped"`：`manifests/latest.json` 已经指向最新 release tag，且更新日志也是最新，无需重复上传。

### HTTP 同步接口

RedBoxweb 也提供了服务端内部接口：

```bash
curl -X POST \
  -H "Authorization: Bearer $SYNC_AUTH_TOKEN" \
  https://your-redboxweb-domain.example.com/api/internal/sync-release
```

这个接口返回的 JSON 结构和 `pnpm sync:release` 一致。

### 启动和定时同步

当 RedBoxweb 运行在 Next.js Node runtime 时，`instrumentation.ts` 会启动同步调度器：

- 服务启动时同步一次；
- 之后每 10 分钟同步一次；
- 如果缺少任一必填同步环境变量，调度器会禁用自己。

如果部署平台是 serverless，长时间运行的 `setInterval` 不一定可靠。这种情况下建议用平台自带定时任务或外部 cron 调用 `POST /api/internal/sync-release`。

### 是否需要数据库

不需要。安装包和浏览器插件 OSS 镜像下载源功能不依赖数据库。

状态直接存在 OSS 对象里：

- 安装包文件：`releases/<tag>/<filename>`；
- 浏览器插件压缩包：`plugins/<tag>/redbox-browser-plugin-<tag>.zip`；
- 最新版本索引：`manifests/latest.json`；
- 插件下载信息：`manifests/latest.json` 里的 `plugin` 对象；
- 全量更新日志：`manifests/latest.json` 里的 `releaseNotes` 数组。

官网会直接从公开 OSS/CDN 地址读取 `manifests/latest.json`。这个功能不需要建表、不需要迁移、不需要本地 SQLite，也不需要外部数据库服务。

### 验证方式

同步后先检查公开 manifest：

```bash
curl "$OSS_PUBLIC_BASE_URL/manifests/latest.json"
```

然后打开：

```text
/download
```

macOS Apple Silicon、macOS Intel、Windows x64 和浏览器插件下载按钮都应该指向 manifest 里的 OSS/CDN URL。如果 manifest 不存在或读取失败，下载页会对不可用资产显示 `镜像准备中`。
