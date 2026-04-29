# Scripts

## `redbox-release-download-stats.mjs`

统计 GitHub 开源仓库所有 Release 下所有上传资产的 `download_count`。

```bash
node scripts/redbox-release-download-stats.mjs
node scripts/redbox-release-download-stats.mjs --format json
node scripts/redbox-release-download-stats.mjs --output ./release-downloads.csv --format csv
```

默认仓库为 `Jamailar/RedBox`，可用 `--repo owner/name` 覆盖。
