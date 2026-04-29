# RedBoxweb

RedBoxweb 是 RedBox 的官网。下载页和更新接口都读取已经同步到 OSS 的 `manifests/latest.json`，把桌面端安装包和浏览器插件下载按钮指向 OSS/CDN 地址。

## App 和插件更新源

线上更新源域名：

```text
https://redbox.ziz.hk/
```

App 安装包更新检查：

```bash
curl "https://redbox.ziz.hk/api/updates/app?platform=windows&arch=x64&currentVersion=1.10.3"
```

支持参数：

| 参数 | 是否必填 | 说明 |
| --- | --- | --- |
| `platform` | 是 | `windows` 或 `macos`。 |
| `arch` | 是 | `x64`、`x86` 或 `arm64`。macOS 使用 `x64` 和 `arm64`。 |
| `currentVersion` | 否 | 当前客户端版本，例如 `1.10.3` 或 `v1.10.3`。不传时，只要更新源可用就会返回 `updateAvailable: true`。 |

浏览器插件更新检查：

```bash
curl "https://redbox.ziz.hk/api/updates/plugin?currentVersion=1.10.3"
```

两个接口都只读取 OSS manifest，不直接访问源仓库。`asset.url` / `plugin.url` 是客户端应该打开或下载的 OSS/CDN 地址。manifest 尚未同步、插件包尚未生成，或请求的系统架构没有对应安装包时，接口会返回 `404`，响应体仍包含 `ready: false` 和可判断的信息；客户端应把它视为“暂时没有可用更新”。

## 安装包 OSS 镜像同步

同步流程：

1. 从 `GITHUB_OWNER/GITHUB_REPO` 读取最新稳定版资产。
2. 只选择 `.dmg`、`.zip`、`.exe` 安装包资产。
3. 跳过更新器元数据，例如 `latest.yml`、`latest-mac.yml`、`.blockmap`。
4. 把安装包上传到 OSS 的 `releases/<tag>/<filename>`。
5. 读取同一个版本 ref 下的 `Plugin/` 目录，把所有插件文件打成 `redbox-browser-plugin-<tag>.zip`。
6. 把插件压缩包上传到 OSS 的 `plugins/<tag>/redbox-browser-plugin-<tag>.zip`。
7. 分页读取历史版本，提取所有非 draft、非 prerelease 的更新日志。
8. 全部安装包和插件压缩包上传成功后，再写入 `manifests/latest.json`。
9. 如果最新 tag 没变，但更新日志变了，只重写 `manifests/latest.json`，不重复上传安装包和插件。
10. `/download` 页面读取 `OSS_PUBLIC_BASE_URL/manifests/latest.json`，把安装包和插件下载按钮指向 manifest 里的 `publicUrl`。
11. `/api/updates/app` 和 `/api/updates/plugin` 读取同一个 manifest，为客户端返回版本、更新日志和 OSS/CDN 下载地址。
12. `/changelog` 页面读取同一个 manifest，展示 `releaseNotes` 里的历史更新日志。

### 环境变量

部署 RedBoxweb 时需要配置：

| 变量 | 是否必填 | 作用 |
| --- | --- | --- |
| `GITHUB_OWNER` | 是 | 源仓库所属账号，通常是 `Jamailar`。 |
| `GITHUB_REPO` | 是 | 源仓库名称，通常是 `RedBox`。 |
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
- `status: "synced"`：最新 tag 没变，但更新日志有变化，并已更新 manifest。
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
