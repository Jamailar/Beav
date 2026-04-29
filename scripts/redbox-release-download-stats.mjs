#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

const DEFAULT_REPO = 'Jamailar/RedBox';
const DEFAULT_PER_PAGE = 100;

function printHelp() {
  console.log(`Usage:
  node scripts/redbox-release-download-stats.mjs [options]

Options:
  --repo <owner/name>     GitHub repo, default: ${DEFAULT_REPO}
  --format <table|json|csv>
                          Output format, default: table
  --output <path>         Write result to file instead of stdout
  --include-drafts        Include draft releases
  --include-prereleases   Include prereleases
  --help                  Show this help

Environment:
  GITHUB_TOKEN / GH_TOKEN Optional GitHub token to avoid low rate limits

Examples:
  node scripts/redbox-release-download-stats.mjs
  node scripts/redbox-release-download-stats.mjs --format json
  node scripts/redbox-release-download-stats.mjs --repo Jamailar/RedBox --output ./release-downloads.json
`);
}

function parseArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    format: 'table',
    output: null,
    includeDrafts: false,
    includePrereleases: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--include-drafts') {
      options.includeDrafts = true;
      continue;
    }

    if (arg === '--include-prereleases') {
      options.includePrereleases = true;
      continue;
    }

    if (arg === '--repo' || arg === '--format' || arg === '--output') {
      const nextValue = argv[index + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }

      if (arg === '--repo') {
        options.repo = nextValue;
      } else if (arg === '--format') {
        options.format = nextValue;
      } else if (arg === '--output') {
        options.output = nextValue;
      }

      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!['table', 'json', 'csv'].includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}`);
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(options.repo)) {
    throw new Error(`Invalid repo format: ${options.repo}. Expected owner/name`);
  }

  return options;
}

function buildHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'redbox-release-download-stats'
  };

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub API request failed (${response.status} ${response.statusText}): ${message}`);
  }

  return response.json();
}

async function fetchAllReleases(repo, options) {
  const headers = buildHeaders();
  const releases = [];

  for (let page = 1; ; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repo}/releases`);
    url.searchParams.set('per_page', String(DEFAULT_PER_PAGE));
    url.searchParams.set('page', String(page));

    const pageItems = await fetchJson(url, headers);
    if (!Array.isArray(pageItems) || pageItems.length === 0) {
      break;
    }

    releases.push(...pageItems);

    if (pageItems.length < DEFAULT_PER_PAGE) {
      break;
    }
  }

  return releases.filter((release) => {
    if (!options.includeDrafts && release.draft) {
      return false;
    }

    if (!options.includePrereleases && release.prerelease) {
      return false;
    }

    return true;
  });
}

function normalizeAsset(release, asset) {
  return {
    tag: release.tag_name,
    releaseName: release.name || release.tag_name,
    publishedAt: release.published_at,
    assetName: asset.name,
    size: asset.size,
    contentType: asset.content_type,
    downloadCount: asset.download_count ?? 0,
    url: asset.browser_download_url
  };
}

function summarize(repo, releases) {
  const normalizedReleases = releases.map((release) => {
    const assets = Array.isArray(release.assets)
      ? release.assets.map((asset) => normalizeAsset(release, asset))
      : [];
    const totalDownloads = assets.reduce((sum, asset) => sum + asset.downloadCount, 0);

    return {
      tag: release.tag_name,
      name: release.name || release.tag_name,
      publishedAt: release.published_at,
      isDraft: Boolean(release.draft),
      isPrerelease: Boolean(release.prerelease),
      assetCount: assets.length,
      totalDownloads,
      assets
    };
  });

  const allAssets = normalizedReleases.flatMap((release) => release.assets);
  const totalDownloads = normalizedReleases.reduce((sum, release) => sum + release.totalDownloads, 0);

  return {
    repo,
    generatedAt: new Date().toISOString(),
    summary: {
      releaseCount: normalizedReleases.length,
      assetCount: allAssets.length,
      totalDownloads
    },
    releases: normalizedReleases,
    assets: allAssets
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function pad(value, width, align = 'start') {
  const text = String(value);
  if (text.length >= width) {
    return text;
  }

  return align === 'end'
    ? `${' '.repeat(width - text.length)}${text}`
    : `${text}${' '.repeat(width - text.length)}`;
}

function toTableRows(columns, rows) {
  const widths = columns.map((column, index) => {
    const maxCellWidth = rows.reduce((max, row) => Math.max(max, String(row[index]).length), column.length);
    return maxCellWidth;
  });

  const header = columns.map((column, index) => pad(column, widths[index])).join('  ');
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  const body = rows.map((row) =>
    row
      .map((cell, index) => pad(cell, widths[index], index >= 2 ? 'end' : 'start'))
      .join('  ')
  );

  return [header, divider, ...body].join('\n');
}

function renderTable(report) {
  const lines = [];

  lines.push(`Repo: ${report.repo}`);
  lines.push(`Generated At: ${report.generatedAt}`);
  lines.push(`Releases: ${formatNumber(report.summary.releaseCount)}`);
  lines.push(`Assets: ${formatNumber(report.summary.assetCount)}`);
  lines.push(`Total Downloads: ${formatNumber(report.summary.totalDownloads)}`);
  lines.push('');
  lines.push('Per Release');
  lines.push(
    toTableRows(
      ['Tag', 'Published At', 'Assets', 'Downloads'],
      report.releases.map((release) => [
        release.tag,
        release.publishedAt || '-',
        release.assetCount,
        release.totalDownloads
      ])
    )
  );
  lines.push('');
  lines.push('Per Asset');
  lines.push(
    toTableRows(
      ['Tag', 'Asset', 'Downloads'],
      report.assets.map((asset) => [asset.tag, asset.assetName, asset.downloadCount])
    )
  );

  return lines.join('\n');
}

function escapeCsv(value) {
  const text = String(value ?? '');
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function renderCsv(report) {
  const lines = [
    'scope,tag,release_name,published_at,asset_name,asset_count,download_count,url'
  ];

  for (const release of report.releases) {
    lines.push([
      'release',
      release.tag,
      release.name,
      release.publishedAt || '',
      '',
      release.assetCount,
      release.totalDownloads,
      ''
    ].map(escapeCsv).join(','));
  }

  for (const asset of report.assets) {
    lines.push([
      'asset',
      asset.tag,
      asset.releaseName,
      asset.publishedAt || '',
      asset.assetName,
      '',
      asset.downloadCount,
      asset.url
    ].map(escapeCsv).join(','));
  }

  return lines.join('\n');
}

function renderOutput(report, format) {
  if (format === 'json') {
    return JSON.stringify(report, null, 2);
  }

  if (format === 'csv') {
    return renderCsv(report);
  }

  return renderTable(report);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const releases = await fetchAllReleases(options.repo, options);
  const report = summarize(options.repo, releases);
  const output = renderOutput(report, options.format);

  if (options.output) {
    await writeFile(options.output, output, 'utf8');
    console.log(`Wrote ${options.format} report to ${options.output}`);
    return;
  }

  console.log(output);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
