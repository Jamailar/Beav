import { attachCdpTab, getDefaultCdpTimeoutMs, sendCdpCommandWithTimeout } from './cdpTransport.js';
import { waitForDownload } from './downloadRuntime.js';

const EXPORT_FORMATS = new Set(['pdf', 'md', 'xlsx', 'csv', 'docx', 'pptx']);
const EXPORT_TIMEOUT_MS = getDefaultCdpTimeoutMs();

export async function exportPage(tabId, action = {}) {
  const normalizedTabId = requireTabId(tabId || action.tabId || action.tab_id, 'page.export');
  const format = normalizeExportFormat(action.format);
  const timeoutMs = Number((action.timeoutMs ?? action.timeout_ms) || EXPORT_TIMEOUT_MS);
  const tab = await chrome.tabs.get(normalizedTabId).catch(() => null);
  if (!tab?.id) throw new Error('page.export requires a valid tab');
  const page = await readPageExportSnapshot(normalizedTabId, timeoutMs);
  const artifact = format === 'pdf'
    ? await buildPdfExport(normalizedTabId, page, timeoutMs)
    : buildTextualExport(format, page);
  const filename = buildExportFilename(format, page);
  const downloadId = await chrome.downloads.download({
    url: artifact.dataUrl,
    filename,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  const waited = await waitForDownload({
    download_id: String(downloadId),
    timeout_ms: timeoutMs,
    sessionId: action.sessionId,
    turnId: action.turnId,
    jobId: action.jobId || action.jobMetadata?.jobId || action.jobMetadata?.job_id,
    storeId: action.storeId || action.jobMetadata?.storeId || action.jobMetadata?.store_id,
    pageRole: action.pageRole || 'page-export',
    source: action.source || 'browser_page_export',
  });
  return {
    success: waited.success === true,
    tabId: normalizedTabId,
    format,
    path: waited.path || null,
    downloadId,
    download_id: String(downloadId),
    mimeType: artifact.mimeType,
    byteSize: artifact.byteSize,
    filename,
    title: page.title,
    url: page.url,
  };
}

async function readPageExportSnapshot(tabId, timeoutMs) {
  await attachCdpTab(tabId);
  const expression = `(() => {
    const title = document.title || '';
    const url = location.href;
    const text = (document.body && document.body.innerText || '').trim();
    const html = document.documentElement ? document.documentElement.outerHTML : '';
    const tables = Array.from(document.querySelectorAll('table')).slice(0, 20).map((table) => (
      Array.from(table.rows).slice(0, 200).map((row) => (
        Array.from(row.cells).slice(0, 50).map((cell) => (cell.innerText || '').trim())
      ))
    ));
    return { title, url, text, html, tables };
  })()`;
  const result = await sendCdpCommandWithTimeout({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, timeoutMs);
  const value = result?.result?.value || {};
  return {
    title: String(value.title || ''),
    url: String(value.url || ''),
    text: String(value.text || ''),
    html: String(value.html || ''),
    tables: Array.isArray(value.tables) ? value.tables : [],
  };
}

async function buildPdfExport(tabId, page, timeoutMs) {
  const printed = await sendCdpCommandWithTimeout({ tabId }, 'Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true,
  }, timeoutMs);
  const data = String(printed?.data || '');
  if (!data) throw new Error('page.export pdf returned empty data');
  return {
    dataUrl: `data:application/pdf;base64,${data}`,
    mimeType: 'application/pdf',
    byteSize: Math.floor(data.length * 0.75),
  };
}

function buildTextualExport(format, page) {
  const content = renderExportContent(format, page);
  const mimeType = exportMimeType(format);
  const base64 = utf8ToBase64(content);
  return {
    dataUrl: `data:${mimeType};base64,${base64}`,
    mimeType,
    byteSize: new TextEncoder().encode(content).byteLength,
  };
}

function renderExportContent(format, page) {
  if (format === 'csv' || format === 'xlsx') {
    const rows = page.tables.flat();
    const tableRows = rows.length ? rows : [
      ['title', page.title],
      ['url', page.url],
      ['text', page.text],
    ];
    return tableRows.map((row) => row.map(csvCell).join(',')).join('\n');
  }
  if (format === 'md') {
    return `# ${page.title || 'Untitled'}\n\n${page.url}\n\n${page.text || htmlToText(page.html)}\n`;
  }
  if (format === 'docx') {
    return [
      page.title || 'Untitled',
      page.url,
      '',
      page.text || htmlToText(page.html),
    ].join('\n');
  }
  if (format === 'pptx') {
    const lines = (page.text || htmlToText(page.html)).split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 12);
    return [`Title,${csvCell(page.title || 'Untitled')}`, `URL,${csvCell(page.url)}`, ...lines.map((line, index) => `Slide ${index + 1},${csvCell(line)}`)].join('\n');
  }
  return page.text || htmlToText(page.html);
}

function normalizeExportFormat(value) {
  const format = String(value || '').toLowerCase();
  if (!EXPORT_FORMATS.has(format)) throw new Error('page.export format must be one of pdf, md, xlsx, csv, docx, pptx');
  return format;
}

function buildExportFilename(format, page) {
  const title = slugify(page.title || new URL(page.url || 'https://redbox.local').hostname || 'page');
  return `redbox-page-export-${title}-${Date.now()}.${format}`;
}

function exportMimeType(format) {
  switch (format) {
    case 'md':
      return 'text/markdown;charset=utf-8';
    case 'csv':
    case 'xlsx':
    case 'pptx':
      return 'text/csv;charset=utf-8';
    case 'docx':
      return 'text/plain;charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function htmlToText(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function slugify(value) {
  return String(value || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
}

function requireTabId(value, label) {
  const tabId = Number(value || 0);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`${label} requires an integer tabId`);
  return tabId;
}
