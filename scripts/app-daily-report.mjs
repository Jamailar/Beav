#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_POSTHOG_HOST = 'https://us.posthog.com';
const DEFAULT_OUTPUT_DIR = path.join(repoRoot, 'artifacts', 'app-daily-reports');

function printHelp() {
  console.log(`Usage:
  node scripts/app-daily-report.mjs [options]

Options:
  --date <YYYY-MM-DD>       Local report date. Default: today in Asia/Shanghai
  --timezone <tz>           IANA timezone, default: Asia/Shanghai
  --env-file <path>         Load environment variables from file, default: ./.env
  --input-json <path>       Render using a prepared JSON payload instead of querying PostHog
  --output-dir <path>       Output directory, default: ./artifacts/app-daily-reports
  --html-only               Generate HTML only, skip PDF rendering
  --sample-data             Render a sample report without calling PostHog
  --help                    Show this help

Environment:
  POSTHOG_PERSONAL_API_KEY  Required unless --sample-data is used
  POSTHOG_PROJECT_ID        Required unless --sample-data is used
  POSTHOG_HOST              Optional, default: ${DEFAULT_POSTHOG_HOST}
  CHROME_PATH               Optional path to Chrome/Chromium for PDF rendering
`);
}

function parseArgs(argv) {
  const options = {
    date: null,
    timezone: process.env.APP_DAILY_REPORT_TIMEZONE || DEFAULT_TIMEZONE,
    envFile: path.join(repoRoot, '.env'),
    inputJson: null,
    outputDir: process.env.APP_DAILY_REPORT_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    htmlOnly: false,
    sampleData: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--html-only') {
      options.htmlOnly = true;
      continue;
    }
    if (arg === '--sample-data') {
      options.sampleData = true;
      continue;
    }
    if (['--date', '--timezone', '--env-file', '--input-json', '--output-dir'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === '--date') options.date = value;
      if (arg === '--timezone') options.timezone = value;
      if (arg === '--env-file') options.envFile = path.resolve(value);
      if (arg === '--input-json') options.inputJson = path.resolve(value);
      if (arg === '--output-dir') options.outputDir = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.date && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error('--date must be YYYY-MM-DD');
  }

  return options;
}

async function loadEnvFile(filePath) {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    return;
  }

  const text = await readFile(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

function datePartsInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

function timezoneOffsetMs(date, timezone) {
  const parts = datePartsInTimezone(date, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedTimeToUtc(year, month, day, hour, minute, second, timezone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const first = new Date(guess.getTime() - timezoneOffsetMs(guess, timezone));
  const secondPass = new Date(guess.getTime() - timezoneOffsetMs(first, timezone));
  return secondPass;
}

function localDateString(date, timezone) {
  const parts = datePartsInTimezone(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0));
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`;
}

function sqlDateTime(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function formatDateTime(date, timezone) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}

function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return '0%';
  return `${(value * 100).toFixed(digits)}%`;
}

function safeRatio(numerator, denominator) {
  const top = Number(numerator || 0);
  const bottom = Number(denominator || 0);
  if (!bottom) return 0;
  return top / bottom;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeHost(host) {
  return String(host || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '');
}

async function posthogQuery(sql) {
  const host = normalizeHost(process.env.POSTHOG_HOST);
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const personalKey = process.env.POSTHOG_PERSONAL_API_KEY;

  if (!projectId) throw new Error('POSTHOG_PROJECT_ID is required');
  if (!personalKey) throw new Error('POSTHOG_PERSONAL_API_KEY is required');

  const response = await fetch(`${host}/api/projects/${encodeURIComponent(projectId)}/query/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${personalKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: {
        kind: 'HogQLQuery',
        query: sql
      }
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PostHog query failed (${response.status}): ${text}`);
  }

  const json = JSON.parse(text);
  return normalizeQueryRows(json);
}

function normalizeQueryRows(json) {
  const rows = Array.isArray(json.results) ? json.results : Array.isArray(json.data) ? json.data : [];
  if (!rows.length) return [];
  if (!Array.isArray(rows[0])) return rows;

  const rawColumns = Array.isArray(json.columns) ? json.columns : [];
  const columns = rawColumns.map((column, index) => {
    if (typeof column === 'string') return column;
    if (column && typeof column.name === 'string') return column.name;
    return `column_${index}`;
  });

  return rows.map((row) => {
    const item = {};
    row.forEach((value, index) => {
      item[columns[index] || `column_${index}`] = value;
    });
    return item;
  });
}

function appScopeWhere() {
  return "(properties.app_session_id IS NOT NULL OR properties.app_name IS NOT NULL)";
}

function betweenWhere(range) {
  return `timestamp >= toDateTime('${range.fromSql}') AND timestamp < toDateTime('${range.toSql}')`;
}

function makeRange(options) {
  const now = new Date();
  const reportDate = options.date || localDateString(now, options.timezone);
  const [year, month, day] = reportDate.split('-').map(Number);
  const start = zonedTimeToUtc(year, month, day, 0, 0, 0, options.timezone);
  const nextDate = addDays(reportDate, 1);
  const [nextYear, nextMonth, nextDay] = nextDate.split('-').map(Number);
  const nextStart = zonedTimeToUtc(nextYear, nextMonth, nextDay, 0, 0, 0, options.timezone);
  const today = localDateString(now, options.timezone);
  const end = reportDate === today && now < nextStart ? now : nextStart;
  const elapsedMs = end.getTime() - start.getTime();
  const previousStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const previousEnd = new Date(previousStart.getTime() + elapsedMs);

  return {
    reportDate,
    timezone: options.timezone,
    start,
    end,
    previousStart,
    previousEnd,
    fromSql: sqlDateTime(start),
    toSql: sqlDateTime(end),
    previousFromSql: sqlDateTime(previousStart),
    previousToSql: sqlDateTime(previousEnd),
    generatedAt: now
  };
}

async function collectData(range) {
  const queries = {
    summary: `SELECT
    count(DISTINCT person_id) AS active_users,
    count(DISTINCT properties.app_session_id) AS app_sessions,
    count() AS total_events,
    countIf(event = 'app_launched') AS app_launches,
    countIf(event = 'user_signed_in') AS sign_ins,
    countIf(event = 'onboarding_completed') AS onboardings_completed,
    countIf(event = 'ai_turn_started') AS ai_turns_started,
    countIf(event = 'ai_turn_completed') AS ai_turns_completed,
    countIf(event = 'ai_turn_failed') AS ai_turns_failed,
    countIf(event = 'topic_selected') AS topics_selected,
    countIf(event = 'checkout_started') AS checkouts_started,
    countIf(event = 'membership_activated') AS memberships_activated,
    countIf(event = 'founder_sponsor_modal_opened') AS founder_modal_opens,
    countIf(event = 'founder_sponsor_purchase_clicked') AS founder_purchase_clicks
FROM events
WHERE ${betweenWhere(range)}
  AND ${appScopeWhere()}`,
    comparison: `SELECT
    'today' AS period,
    count(DISTINCT person_id) AS active_users,
    count(DISTINCT properties.app_session_id) AS app_sessions,
    count() AS total_events,
    countIf(event = 'app_launched') AS launches,
    countIf(event = 'ai_turn_started') AS ai_turns_started,
    countIf(event = 'founder_sponsor_modal_opened') AS founder_modal_opens,
    countIf(event = 'founder_sponsor_purchase_clicked') AS founder_purchase_clicks,
    countIf(event = 'checkout_started' AND toFloat(properties.amount) > 0) AS paid_checkouts_started,
    countIf(event = 'membership_activated') AS memberships_activated
FROM events
WHERE ${betweenWhere(range)}
  AND ${appScopeWhere()}
UNION ALL
SELECT
    'previous_same_window' AS period,
    count(DISTINCT person_id) AS active_users,
    count(DISTINCT properties.app_session_id) AS app_sessions,
    count() AS total_events,
    countIf(event = 'app_launched') AS launches,
    countIf(event = 'ai_turn_started') AS ai_turns_started,
    countIf(event = 'founder_sponsor_modal_opened') AS founder_modal_opens,
    countIf(event = 'founder_sponsor_purchase_clicked') AS founder_purchase_clicks,
    countIf(event = 'checkout_started' AND toFloat(properties.amount) > 0) AS paid_checkouts_started,
    countIf(event = 'membership_activated') AS memberships_activated
FROM events
WHERE timestamp >= toDateTime('${range.previousFromSql}')
  AND timestamp < toDateTime('${range.previousToSql}')
  AND ${appScopeWhere()}`,
    hourly: `SELECT
    formatDateTime(toStartOfHour(toTimeZone(timestamp, '${range.timezone}')), '%H:00') AS hour,
    count(DISTINCT person_id) AS active_users,
    count() AS events,
    countIf(event = 'app_launched') AS launches,
    countIf(event = 'ai_turn_started') AS ai_turns_started,
    countIf(event = 'founder_sponsor_modal_opened') AS founder_modal_opens
FROM events
WHERE ${betweenWhere(range)}
  AND ${appScopeWhere()}
GROUP BY hour
ORDER BY hour
LIMIT 48`,
    sources: `SELECT
    acquisition_source,
    count() AS users
FROM (
    SELECT
        person_id,
        argMin(coalesce(nullIf(toString(properties.acquisitionSource), ''), 'unknown'), timestamp) AS acquisition_source
    FROM events
    WHERE ${betweenWhere(range)}
      AND event = 'app_launched'
      AND person_id IS NOT NULL
    GROUP BY person_id
)
GROUP BY acquisition_source
ORDER BY users DESC
LIMIT 20`,
    paidSources: `SELECT
    coalesce(nullIf(toString(properties.acquisitionSource), ''), 'unknown') AS acquisition_source,
    count(DISTINCT person_id) AS paid_users,
    count() AS payment_events
FROM events
WHERE ${betweenWhere(range)}
  AND event = 'checkout_started'
  AND toFloat(properties.amount) > 0
GROUP BY acquisition_source
ORDER BY paid_users DESC, payment_events DESC
LIMIT 20`,
    paidFirstTouchSources: `SELECT
    acquisition_source,
    count() AS paid_users
FROM (
    SELECT
        paid_people.person_id AS person_id,
        coalesce(
          nullIf(
            argMinIf(
              toString(events.properties.acquisitionSource),
              events.timestamp,
              events.event = 'app_launched'
                AND events.person_id = paid_people.person_id
                AND nullIf(toString(events.properties.acquisitionSource), '') IS NOT NULL
            ),
            ''
          ),
          'unknown'
        ) AS acquisition_source
    FROM (
        SELECT DISTINCT person_id
        FROM events
        WHERE ${betweenWhere(range)}
          AND event = 'checkout_started'
          AND toFloat(properties.amount) > 0
          AND person_id IS NOT NULL
    ) AS paid_people
    LEFT JOIN events ON events.person_id = paid_people.person_id
    GROUP BY paid_people.person_id
)
GROUP BY acquisition_source
ORDER BY paid_users DESC
LIMIT 20`,
    conversion: `SELECT
    '打开创始赞助弹窗' AS step,
    count() AS events,
    count(DISTINCT person_id) AS users,
    count(DISTINCT properties.app_session_id) AS app_sessions
FROM events
WHERE ${betweenWhere(range)}
  AND event = 'founder_sponsor_modal_opened'
UNION ALL
SELECT
    '点击弹窗购买按钮' AS step,
    count() AS events,
    count(DISTINCT person_id) AS users,
    count(DISTINCT properties.app_session_id) AS app_sessions
FROM events
WHERE ${betweenWhere(range)}
  AND event = 'founder_sponsor_purchase_clicked'
UNION ALL
SELECT
    '创建支付订单' AS step,
    count() AS events,
    count(DISTINCT person_id) AS users,
    count(DISTINCT properties.app_session_id) AS app_sessions
FROM events
WHERE ${betweenWhere(range)}
  AND event = 'checkout_started'
  AND toFloat(properties.amount) > 0
UNION ALL
SELECT
    '会员激活' AS step,
    count() AS events,
    count(DISTINCT person_id) AS users,
    count(DISTINCT properties.app_session_id) AS app_sessions
FROM events
WHERE ${betweenWhere(range)}
  AND event = 'membership_activated'`,
    behavior: `SELECT
    CASE
      WHEN event IN ('app_launched','surface_viewed') THEN '浏览和启动'
      WHEN event IN ('onboarding_step_viewed','onboarding_step_completed','onboarding_completed','acquisition_survey_shown','acquisition_survey_answered','acquisition_survey_skipped') THEN '新手引导'
      WHEN event IN ('ai_turn_started','ai_turn_completed','ai_turn_failed') THEN 'AI 对话'
      WHEN event LIKE 'topic_%' OR event IN ('knowledge_item_added','redclaw_task_submitted') THEN '主题/知识工作流'
      WHEN event LIKE 'image_generation_%' OR event LIKE 'video_generation_%' OR event = 'media_generation_requested' THEN '媒体生成'
      WHEN event LIKE 'membership_%' OR event LIKE 'checkout_%' OR event LIKE 'founder_sponsor_%' THEN '会员/付费'
      WHEN event LIKE 'user_signed_%' OR event = 'settings_changed' THEN '账号/设置'
      ELSE '其他'
    END AS behavior_area,
    count() AS events,
    count(DISTINCT person_id) AS users
FROM events
WHERE ${betweenWhere(range)}
  AND ${appScopeWhere()}
GROUP BY behavior_area
ORDER BY events DESC
LIMIT 20`,
    surfaces: `SELECT
    coalesce(nullIf(toString(properties.surface), ''), 'unknown') AS surface,
    count() AS views,
    count(DISTINCT person_id) AS users
FROM events
WHERE ${betweenWhere(range)}
  AND event = 'surface_viewed'
GROUP BY surface
ORDER BY views DESC
LIMIT 20`
  };

  const out = {};
  for (const [key, sql] of Object.entries(queries)) {
    out[key] = await posthogQuery(sql);
  }
  return out;
}

function sampleData() {
  return {
    summary: [{
      active_users: 39,
      app_sessions: 39,
      total_events: 1896,
      app_launches: 93,
      sign_ins: 23,
      onboardings_completed: 25,
      ai_turns_started: 180,
      ai_turns_completed: 80,
      ai_turns_failed: 0,
      topics_selected: 29,
      checkouts_started: 8,
      memberships_activated: 9,
      founder_modal_opens: 24,
      founder_purchase_clicks: 2
    }],
    comparison: [
      { period: 'today', active_users: 39, app_sessions: 39, total_events: 1896, launches: 93, ai_turns_started: 180, founder_modal_opens: 24, founder_purchase_clicks: 2 },
      { period: 'previous_same_window', active_users: 51, app_sessions: 51, total_events: 1685, launches: 61, ai_turns_started: 121, founder_modal_opens: 0, founder_purchase_clicks: 0 }
    ],
    hourly: [
      { hour: '00:00', active_users: 4, events: 157, launches: 26, ai_turns_started: 1, founder_modal_opens: 1 },
      { hour: '04:00', active_users: 7, events: 224, launches: 5, ai_turns_started: 12, founder_modal_opens: 4 },
      { hour: '08:00', active_users: 6, events: 94, launches: 6, ai_turns_started: 0, founder_modal_opens: 4 },
      { hour: '12:00', active_users: 7, events: 206, launches: 6, ai_turns_started: 39, founder_modal_opens: 2 },
      { hour: '13:00', active_users: 6, events: 261, launches: 11, ai_turns_started: 42, founder_modal_opens: 4 }
    ],
    sources: [
      { acquisition_source: 'github', users: 13 },
      { acquisition_source: 'unknown', users: 10 },
      { acquisition_source: 'other', users: 8 },
      { acquisition_source: 'ai_recommendation', users: 3 },
      { acquisition_source: 'search', users: 2 }
    ],
    paidSources: [
      { acquisition_source: 'github', paid_users: 1, payment_events: 1 }
    ],
    conversion: [
      { step: '打开创始赞助弹窗', events: 24, users: 16, app_sessions: 16 },
      { step: '点击弹窗购买按钮', events: 2, users: 2, app_sessions: 2 },
      { step: '创建支付订单', events: 8, users: 7, app_sessions: 7 },
      { step: '会员激活', events: 9, users: 3, app_sessions: 3 }
    ],
    behavior: [
      { behavior_area: '浏览和启动', events: 865, users: 38 },
      { behavior_area: '新手引导', events: 421, users: 25 },
      { behavior_area: 'AI 对话', events: 260, users: 13 },
      { behavior_area: '主题/知识工作流', events: 213, users: 23 },
      { behavior_area: '会员/付费', events: 93, users: 32 }
    ],
    surfaces: [
      { surface: 'redclaw', views: 198, users: 37 },
      { surface: 'knowledge', views: 131, users: 30 },
      { surface: 'subjects', views: 111, users: 28 },
      { surface: 'settings', views: 90, users: 29 }
    ]
  };
}

function maxOf(rows, key) {
  return Math.max(1, ...rows.map((row) => Number(row[key] || 0)));
}

function emptyChart(message, options = {}) {
  const width = options.width || 820;
  const height = options.height || 220;
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img">
<rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#f8fafc" stroke="#dbe2ee"></rect>
<text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="axis-label">${escapeHtml(message)}</text>
</svg>`;
}

function barChart(rows, labelKey, valueKey, options = {}) {
  if (!rows.length) {
    return emptyChart(options.emptyMessage || '当前窗口暂无数据', { width: options.width || 820, height: options.height || 220 });
  }
  const width = options.width || 820;
  const rowHeight = options.rowHeight || 34;
  const left = options.left || 170;
  const right = 72;
  const top = 20;
  const height = top * 2 + rowHeight * rows.length;
  const max = maxOf(rows, valueKey);
  const barWidth = width - left - right;
  const fill = options.fill || '#2563eb';

  const body = rows.map((row, index) => {
    const value = Number(row[valueKey] || 0);
    const y = top + index * rowHeight;
    const w = Math.max(2, Math.round((value / max) * barWidth));
    return `<text x="0" y="${y + 20}" class="chart-label">${escapeHtml(row[labelKey])}</text>
<rect x="${left}" y="${y + 4}" width="${w}" height="18" rx="4" fill="${fill}"></rect>
<text x="${left + w + 8}" y="${y + 19}" class="chart-value">${formatNumber(value)}</text>`;
  }).join('\n');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img">${body}</svg>`;
}

function lineChart(rows, xKey, yKey, options = {}) {
  if (!rows.length) {
    return emptyChart(options.emptyMessage || '当前窗口暂无小时趋势数据', { width: options.width || 820, height: options.height || 280 });
  }
  const width = options.width || 820;
  const height = options.height || 280;
  const padLeft = 48;
  const padRight = 24;
  const padTop = 24;
  const padBottom = 46;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const max = maxOf(rows, yKey);
  const points = rows.map((row, index) => {
    const x = padLeft + (rows.length <= 1 ? 0 : (index / (rows.length - 1)) * plotWidth);
    const y = padTop + plotHeight - (Number(row[yKey] || 0) / max) * plotHeight;
    return { x, y, row };
  });
  const pathData = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const circles = points.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4" fill="#2563eb"></circle>`).join('');
  const labels = points
    .filter((_, index) => index % Math.ceil(points.length / 8 || 1) === 0 || index === points.length - 1)
    .map((point) => `<text x="${point.x.toFixed(1)}" y="${height - 18}" text-anchor="middle" class="axis-label">${escapeHtml(point.row[xKey])}</text>`)
    .join('');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img">
<line x1="${padLeft}" y1="${padTop + plotHeight}" x2="${width - padRight}" y2="${padTop + plotHeight}" stroke="#d5dbe7"></line>
<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotHeight}" stroke="#d5dbe7"></line>
<text x="${padLeft - 8}" y="${padTop + 8}" text-anchor="end" class="axis-label">${formatNumber(max)}</text>
<text x="${padLeft - 8}" y="${padTop + plotHeight}" text-anchor="end" class="axis-label">0</text>
<path d="${pathData}" fill="none" stroke="#2563eb" stroke-width="3"></path>
${circles}
${labels}
</svg>`;
}

function tableHtml(rows, columns) {
  if (!rows.length) return '<p class="muted">暂无数据</p>';
  const header = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('');
  const body = rows.map((row) => `<tr>${columns.map((column) => {
    const value = row[column.key];
    const text = column.format === 'number' ? formatNumber(value) : value;
    return `<td>${escapeHtml(text)}</td>`;
  }).join('')}</tr>`).join('');
  return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function rowBy(rows, key, value) {
  return rows.find((row) => row[key] === value) || {};
}

function buildCoreMetrics(summary) {
  return [
    { metric: 'App 活跃用户', value: Number(summary.active_users || 0) },
    { metric: 'App Sessions', value: Number(summary.app_sessions || 0) },
    { metric: '事件总数', value: Number(summary.total_events || 0) },
    { metric: '启动', value: Number(summary.app_launches || 0) },
    { metric: '登录', value: Number(summary.sign_ins || 0) },
    { metric: 'Onboarding 完成', value: Number(summary.onboardings_completed || 0) },
    { metric: 'AI 对话开始', value: Number(summary.ai_turns_started || 0) },
    { metric: 'AI 对话完成', value: Number(summary.ai_turns_completed || 0) },
    { metric: 'AI 对话失败', value: Number(summary.ai_turns_failed || 0) },
    { metric: 'checkout_started', value: Number(summary.checkouts_started || 0) },
    { metric: 'membership_activated', value: Number(summary.memberships_activated || 0) },
    { metric: 'founder_sponsor_modal_opened', value: Number(summary.founder_modal_opens || 0) },
    { metric: 'founder_sponsor_purchase_clicked', value: Number(summary.founder_purchase_clicks || 0) }
  ];
}

function pctChange(current, previous) {
  const curr = Number(current || 0);
  const prev = Number(previous || 0);
  if (!prev) return null;
  return (curr - prev) / prev;
}

function trendPhrase(metricName, current, previous) {
  const change = pctChange(current, previous);
  if (change === null) return `${metricName}缺少上一周期基线。`;
  const direction = change >= 0 ? '上升' : '下降';
  return `${metricName}较昨日同窗口${direction} ${formatPercent(Math.abs(change))}（${formatNumber(previous)} -> ${formatNumber(current)}）。`;
}

function enrichData(data) {
  const summary = data.summary[0] || {};
  const sourceUsersTotal = (data.sources || []).reduce((sum, row) => sum + Number(row.users || 0), 0);
  const sources = (data.sources || []).map((row) => ({
    ...row,
    users: Number(row.users || 0),
    share: safeRatio(row.users, sourceUsersTotal),
    share_text: formatPercent(safeRatio(row.users, sourceUsersTotal))
  }));
  const unknownSource = sources.find((row) => row.acquisition_source === 'unknown');
  const paidSources = (data.paidSources || []).map((row) => ({
    ...row,
    paid_users: Number(row.paid_users || 0),
    payment_events: Number(row.payment_events || 0)
  }));
  const paidUsersTotal = paidSources.reduce((sum, row) => sum + Number(row.paid_users || 0), 0);
  const paidFirstTouchSources = (data.paidFirstTouchSources || []).map((row) => ({
    ...row,
    paid_users: Number(row.paid_users || 0),
    share: safeRatio(row.paid_users, paidUsersTotal),
    share_text: formatPercent(safeRatio(row.paid_users, paidUsersTotal))
  }));
  const conversionSteps = (data.conversion || []).map((row, index, rows) => {
    const previousUsers = index === 0 ? Number(row.users || 0) : Number(rows[index - 1].users || 0);
    return {
      ...row,
      events: Number(row.events || 0),
      users: Number(row.users || 0),
      app_sessions: Number(row.app_sessions || 0),
      user_conversion_rate: index === 0 ? 1 : safeRatio(row.users, previousUsers),
      user_conversion_rate_text: formatPercent(index === 0 ? 1 : safeRatio(row.users, previousUsers))
    };
  });

  return {
    ...data,
    coreMetrics: buildCoreMetrics(summary),
    sources,
    paidSources,
    paidFirstTouchSources,
    conversion: conversionSteps,
    unknownSourceShare: unknownSource ? unknownSource.share : 0
  };
}

function buildAnalysis(data) {
  const summary = data.summary[0] || {};
  const today = rowBy(data.comparison, 'period', 'today');
  const previous = rowBy(data.comparison, 'period', 'previous_same_window');
  const previousEvents = Number(previous.total_events || 0);
  const todayEvents = Number(today.total_events || summary.total_events || 0);
  const earlyWindowNoData = todayEvents === 0 && previousEvents > 0;
  const topHour = [...data.hourly].sort((a, b) => Number(b.events || 0) - Number(a.events || 0))[0];
  const topActiveHour = [...data.hourly].sort((a, b) => Number(b.active_users || 0) - Number(a.active_users || 0))[0];
  const topSource = data.sources[0];
  const unknownSource = data.sources.find((row) => row.acquisition_source === 'unknown');
  const topPaidSource = data.paidSources[0];
  const openStep = data.conversion.find((row) => row.step === '打开创始赞助弹窗') || {};
  const clickStep = data.conversion.find((row) => row.step === '点击弹窗购买按钮') || {};
  const paidStep = data.conversion.find((row) => row.step === '创建支付订单') || {};
  const activatedStep = data.conversion.find((row) => row.step === '会员激活') || {};
  const topPaidFirstTouchSource = data.paidFirstTouchSources[0];
  const clickRate = safeRatio(clickStep.users, openStep.users);
  const checkoutRate = safeRatio(paidStep.users, clickStep.users);
  const activationRate = safeRatio(activatedStep.users, paidStep.users);
  const aiCompletion = safeRatio(summary.ai_turns_completed, summary.ai_turns_started);

  if (earlyWindowNoData) {
    return {
      habits: [
        '当前窗口内尚未收到 RedBox App 事件，小时趋势、行为分布和页面访问均为空。',
        `昨日同长度窗口已有 ${formatNumber(previous.active_users)} 位活跃用户、${formatNumber(previous.total_events)} 个事件，说明这更像执行时机过早，而不是埋点失效。`,
        '建议把正式日报固定在 Asia/Shanghai 21:00 左右执行；凌晨手动补跑时优先查看上一完整日。'
      ],
      sources: [
        '当前窗口没有 app_launched，因此今日来源分布和 unknown 占比均为空。',
        '如果需要看有意义的来源分布，应改查上一完整日或等待当天产生真实启动事件后再跑。'
      ],
      conversion: [
        '当前窗口没有创始赞助弹窗、购买点击、支付订单和会员激活事件，因此转化漏斗为 0。',
        `昨日同长度窗口仍有 ${formatNumber(previous.paid_checkouts_started)} 次付费订单，说明支付链路并未整体消失。`
      ],
      replay: [
        `当前窗口事件量为 0，昨日同窗口为 ${formatNumber(previous.total_events)}。`,
        `当前窗口活跃用户为 0，昨日同窗口为 ${formatNumber(previous.active_users)}。`,
        `当前窗口 AI 对话开始为 0，昨日同窗口为 ${formatNumber(previous.ai_turns_started)}。`
      ],
      earlyWindowNoData
    };
  }

  return {
    habits: [
      topHour ? `事件高峰在 ${topHour.hour}，共产生 ${formatNumber(topHour.events)} 个事件；活跃用户高峰在 ${topActiveHour?.hour || topHour.hour}。` : '暂无小时趋势数据。',
      data.surfaces[0] ? `最常访问的页面是 ${data.surfaces[0].surface}，访问 ${formatNumber(data.surfaces[0].views)} 次，覆盖 ${formatNumber(data.surfaces[0].users)} 人。` : '暂无页面访问数据。',
      `AI 对话开始 ${formatNumber(summary.ai_turns_started)} 次，完成 ${formatNumber(summary.ai_turns_completed)} 次，完成率 ${formatPercent(aiCompletion)}。`
    ],
    sources: [
      topSource ? `最大用户来源是 ${topSource.acquisition_source}，${formatNumber(topSource.users)} 人。` : '暂无用户来源数据。',
      unknownSource ? `unknown 来源仍有 ${formatNumber(unknownSource.users)} 人，占来源人群 ${formatPercent(data.unknownSourceShare)}，建议继续补齐安装包、官网跳转或问卷来源采集。` : '未发现 unknown 来源用户。',
      topPaidSource ? `付费订单最大来源是 ${topPaidSource.acquisition_source}，${formatNumber(topPaidSource.paid_users)} 个付费用户。` : '今日暂无可按 checkout_started 归因的付费用户。',
      topPaidFirstTouchSource ? `若按首触 app_launched 归因，付费用户首触最大来源是 ${topPaidFirstTouchSource.acquisition_source}。` : '今日暂无可补充的付费首触来源。'
    ],
    conversion: [
      `创始赞助弹窗打开 ${formatNumber(openStep.events)} 次、${formatNumber(openStep.users)} 人；购买按钮点击 ${formatNumber(clickStep.events)} 次、${formatNumber(clickStep.users)} 人。`,
      `弹窗打开用户到购买按钮点击转化率 ${formatPercent(clickRate)}；购买按钮点击到创建支付订单转化率 ${formatPercent(checkoutRate)}；订单到激活转化率 ${formatPercent(activationRate)}。`,
      `会员激活 ${formatNumber(summary.memberships_activated)} 次，checkout_started ${formatNumber(summary.checkouts_started)} 次。`
    ],
    replay: [
      trendPhrase('活跃用户', today.active_users, previous.active_users),
      trendPhrase('事件量', today.total_events, previous.total_events),
      trendPhrase('AI 对话开始数', today.ai_turns_started, previous.ai_turns_started),
      trendPhrase('付费按钮点击数', today.founder_purchase_clicks, previous.founder_purchase_clicks),
      trendPhrase('付费订单数', today.paid_checkouts_started, previous.paid_checkouts_started)
    ],
    earlyWindowNoData
  };
}

function renderHtml(data, range) {
  const summary = data.summary[0] || {};
  const analysis = buildAnalysis(data);
  const title = `RedBox App 使用日报 - ${range.reportDate}`;
  const period = `${formatDateTime(range.start, range.timezone)} - ${formatDateTime(range.end, range.timezone)} ${range.timezone}`;

  const metricCards = [
    ['活跃用户', summary.active_users],
    ['App Sessions', summary.app_sessions],
    ['事件总数', summary.total_events],
    ['App 启动', summary.app_launches],
    ['AI 对话开始', summary.ai_turns_started],
    ['会员激活', summary.memberships_activated],
    ['创始赞助弹窗打开', summary.founder_modal_opens],
    ['弹窗购买点击', summary.founder_purchase_clicks]
  ].map(([label, value]) => `<div class="metric"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${formatNumber(value)}</div></div>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 15mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #172033; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f6f8fb; }
    main { max-width: 980px; margin: 0 auto; padding: 28px; background: #fff; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 28px 0 12px; font-size: 18px; border-left: 4px solid #2563eb; padding-left: 10px; }
    h3 { margin: 18px 0 10px; font-size: 15px; }
    p { line-height: 1.65; }
    .muted { color: #657083; }
    .period { color: #657083; margin-bottom: 18px; }
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 18px 0 22px; }
    .metric { border: 1px solid #dbe2ee; border-radius: 8px; padding: 12px; background: #fbfcff; }
    .metric-label { font-size: 12px; color: #657083; }
    .metric-value { font-size: 24px; font-weight: 700; margin-top: 6px; }
    .notice { border: 1px solid #f5c98f; background: #fff7ed; color: #9a3412; border-radius: 8px; padding: 12px 14px; margin: 0 0 18px; line-height: 1.6; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .panel { break-inside: avoid; border: 1px solid #dbe2ee; border-radius: 8px; padding: 14px; background: #fff; margin-bottom: 14px; }
    .chart { width: 100%; height: auto; display: block; }
    .chart-label, .chart-value, .axis-label { font-size: 13px; fill: #334155; }
    .chart-value { font-weight: 700; }
    ul { margin: 8px 0 0 20px; padding: 0; }
    li { margin: 6px 0; line-height: 1.6; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #e5eaf2; padding: 8px 6px; text-align: left; }
    th { color: #657083; font-weight: 600; background: #f8fafc; }
    .page-break { break-before: page; }
    .footer { margin-top: 28px; color: #657083; font-size: 12px; }
    @media print {
      body { background: #fff; }
      main { padding: 0; }
      .panel { break-inside: avoid; }
    }
  </style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <div class="period">统计窗口：${escapeHtml(period)}；生成时间：${escapeHtml(formatDateTime(range.generatedAt, range.timezone))}</div>
  ${analysis.earlyWindowNoData ? `<div class="notice">当前日报是在当天较早时刻生成，窗口内尚未收到 App 事件。页面中的 0 值是 live PostHog 真结果，不是渲染错误；若需要可读性更强的日报，应优先查看上一完整日或等待当天晚些时候重跑。</div>` : ''}
  <section class="metrics">${metricCards}</section>

  <section class="panel">
    <h2>复盘摘要</h2>
    <h3>用户行为习惯</h3>
    <ul>${analysis.habits.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    <h3>用户来源与付费来源</h3>
    <ul>${analysis.sources.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    <h3>付费点击转化</h3>
    <ul>${analysis.conversion.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    <h3>同窗口对比</h3>
    <ul>${analysis.replay.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
  </section>

  <section class="panel">
    <h2>核心指标</h2>
    ${tableHtml(data.coreMetrics, [
      { key: 'metric', label: '指标' },
      { key: 'value', label: '数值', format: 'number' }
    ])}
  </section>

  <section class="panel">
    <h2>每小时活跃用户</h2>
    ${lineChart(data.hourly, 'hour', 'active_users')}
    ${tableHtml(data.hourly, [
      { key: 'hour', label: '小时' },
      { key: 'active_users', label: '活跃用户', format: 'number' },
      { key: 'events', label: '事件数', format: 'number' },
      { key: 'launches', label: '启动', format: 'number' },
      { key: 'ai_turns_started', label: 'AI 对话', format: 'number' },
      { key: 'founder_modal_opens', label: '弹窗打开', format: 'number' }
    ])}
  </section>

  <div class="grid">
    <section class="panel">
      <h2>用户来源</h2>
      ${barChart(data.sources, 'acquisition_source', 'users', { left: 155, fill: '#0f766e' })}
      ${tableHtml(data.sources, [
        { key: 'acquisition_source', label: '来源' },
        { key: 'users', label: '用户数', format: 'number' },
        { key: 'share_text', label: '来源占比' }
      ])}
    </section>
    <section class="panel">
      <h2>付费用户来源</h2>
      ${barChart(data.paidSources, 'acquisition_source', 'paid_users', { left: 155, fill: '#b45309' })}
      ${tableHtml(data.paidSources, [
        { key: 'acquisition_source', label: '来源' },
        { key: 'paid_users', label: '付费用户', format: 'number' },
        { key: 'payment_events', label: '支付事件', format: 'number' }
      ])}
    </section>
  </div>

  <section class="panel">
    <h2>付费用户首触来源</h2>
    ${barChart(data.paidFirstTouchSources, 'acquisition_source', 'paid_users', { left: 155, fill: '#c2410c' })}
    ${tableHtml(data.paidFirstTouchSources, [
      { key: 'acquisition_source', label: '首触来源' },
      { key: 'paid_users', label: '付费用户', format: 'number' },
      { key: 'share_text', label: '付费占比' }
    ])}
  </section>

  <section class="panel">
    <h2>行为分布</h2>
    ${barChart(data.behavior, 'behavior_area', 'events', { left: 170, fill: '#2563eb' })}
  </section>

  <div class="grid">
    <section class="panel">
      <h2>页面访问</h2>
      ${barChart(data.surfaces, 'surface', 'views', { left: 135, fill: '#7c3aed' })}
    </section>
    <section class="panel">
      <h2>付费点击转化</h2>
      ${barChart(data.conversion, 'step', 'users', { left: 155, fill: '#dc2626' })}
      ${tableHtml(data.conversion, [
        { key: 'step', label: '步骤' },
        { key: 'events', label: '事件', format: 'number' },
        { key: 'users', label: '用户', format: 'number' },
        { key: 'app_sessions', label: 'Session', format: 'number' },
        { key: 'user_conversion_rate_text', label: '用户转化率' }
      ])}
    </section>
  </div>

  <div class="footer">
    数据源：PostHog HogQL。用户数按 person_id 去重；来源按用户当天首次 app_launched.acquisitionSource 去重；付费来源按 checkout_started 的 acquisitionSource 归因。
  </div>
</main>
</body>
</html>`;
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/opt/homebrew/bin/chromium',
    '/usr/local/bin/chromium',
    path.join(homedir(), '.cache', 'ms-playwright', 'chromium-1161', 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function renderPdf(htmlPath, pdfPath) {
  const chrome = await findChrome();
  if (!chrome) {
    throw new Error('Cannot find Chrome/Chromium. Set CHROME_PATH or run with --html-only.');
  }

  await new Promise((resolve, reject) => {
    const child = spawn(chrome, [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`
    ], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Chrome PDF rendering failed with exit code ${code}`));
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  let range;
  let data;

  if (options.inputJson) {
    const payload = JSON.parse(await readFile(options.inputJson, 'utf8'));
    range = {
      ...payload.range,
      start: new Date(payload.range.start),
      end: new Date(payload.range.end),
      previousStart: new Date(payload.range.previousStart),
      previousEnd: new Date(payload.range.previousEnd),
      generatedAt: new Date(payload.range.generatedAt)
    };
    data = enrichData(payload.data);
  } else {
    await loadEnvFile(options.envFile);
    range = makeRange(options);
    const rawData = options.sampleData ? sampleData() : await collectData(range);
    data = enrichData(rawData);
  }

  const html = renderHtml(data, range);

  await mkdir(options.outputDir, { recursive: true });
  const baseName = `app-daily-report-${range.reportDate}`;
  const htmlPath = path.join(options.outputDir, `${baseName}.html`);
  const pdfPath = path.join(options.outputDir, `${baseName}.pdf`);
  const jsonPath = path.join(options.outputDir, `${baseName}.json`);

  await writeFile(htmlPath, html, 'utf8');
  console.log(`Wrote HTML report: ${htmlPath}`);
  await writeFile(jsonPath, JSON.stringify({ range, data }, null, 2), 'utf8');
  console.log(`Wrote JSON report: ${jsonPath}`);

  if (!options.htmlOnly) {
    await renderPdf(htmlPath, pdfPath);
    console.log(`Wrote PDF report: ${pdfPath}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
