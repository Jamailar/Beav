# Scripts

## `minimax-h3-video.mjs`

本地的 MiniMax H3 / H3 Max 视频工作流。密钥只读取仓库根目录、已被 Git 忽略的 `.env` 中的 `MINIMAX_API_KEY`；不会把密钥写入任务回执或产物。

```bash
pnpm video:minimax -- help

# 文生视频：创建、等待并下载
pnpm video:minimax -- generate \
  --prompt '白色背景、快节奏的 AI 产品宣传动画' \
  --duration 15 --resolution 2K --ratio 16:9 --wait --download

# 用首尾帧控制开始与结束画面
pnpm video:minimax -- generate \
  --prompt '镜头从首帧丝滑过渡到尾帧，保持干净的白色产品质感' \
  --first-frame ./assets/first.png --last-frame ./assets/last.png \
  --duration 8 --wait --download

# 多参考素材：本地文件会自动上传并以 mm_file:// 临时引用提交
pnpm video:minimax -- generate \
  --prompt '参考图 1 的人物与图 2 的美术风格，按参考视频的镜头节奏，使用参考音频的男声完成口播' \
  --reference-image ./assets/character.png \
  --reference-image ./assets/style.png \
  --reference-video ./assets/rhythm.mp4 \
  --reference-audio ./assets/narration.mp3 \
  --duration 15 --ratio 16:9 --context --wait --download

# 任务管理与 768P → 2K 再生成
pnpm video:minimax -- query <task-id>
pnpm video:minimax -- wait <task-id> --download
pnpm video:minimax -- regenerate --source-task-id <task-id> --wait --download
```

常用能力：文生视频、首帧/尾帧、参考图（最多 9 张）、参考视频（最多 3 段）、参考音频（最多 3 段）、H3-Context-IR 提示词增强、异步任务查询/取消/删除、下载，以及 H3 768P 到 2K 再生成。运行 `pnpm video:minimax -- help` 查看完整参数和限制。

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
