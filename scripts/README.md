# Scripts

## `redbox-release-download-stats.mjs`

统计 GitHub 开源仓库所有 Release 下所有上传资产的 `download_count`。

```bash
node scripts/redbox-release-download-stats.mjs
node scripts/redbox-release-download-stats.mjs --format json
node scripts/redbox-release-download-stats.mjs --output ./release-downloads.csv --format csv
```

默认仓库为 `Jamailar/RedBox`，可用 `--repo owner/name` 覆盖。

## `app-daily-report.mjs`

每天生成 RedBox App 使用日报，输出 HTML 和 PDF，包含活跃、行为、来源、付费来源、创始赞助会员点击转化和复盘分析。

```bash
cp scripts/app-daily-report.env.example .env
# 填写 POSTHOG_HOST、POSTHOG_PROJECT_ID、POSTHOG_PERSONAL_API_KEY
npm run report:app-daily
npm run report:app-daily -- --date 2026-06-27
npm run report:app-daily -- --html-only
```

默认输出到 `artifacts/app-daily-reports/`。

## `install-app-daily-report-launchd.mjs`

在 macOS 安装本机 LaunchAgent，每天本地时间 21:00 自动运行 `app-daily-report.mjs`。

```bash
npm run report:app-daily:install
launchctl kickstart -k gui/$(id -u)/com.redconvert.app-daily-report
```

定时任务读取仓库根目录 `.env`，日志写入 `~/Library/Logs/RedConvert/`。
