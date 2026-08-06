import { normalizeCaptureText } from './captureDocument.js';

const BLOCKED_PATTERNS = [
  /captcha|verify you are human|security check|access denied/i,
  /请完成安全验证|请先登录|登录后查看|滑块验证|访问受限|人机验证/i,
];

export function assessCaptureQuality(document) {
  const text = normalizeCaptureText(document?.content?.text || document?.content?.markdown, 24_000);
  const title = normalizeCaptureText(document?.content?.title, 500);
  const probe = `${title}\n${text}`.slice(0, 6_000);
  const warnings = [...(Array.isArray(document?.diagnostics?.warnings) ? document.diagnostics.warnings : [])];
  const isBlocked = BLOCKED_PATTERNS.some((pattern) => pattern.test(probe));

  if (isBlocked) {
    return { status: 'blocked', accepted: false, warnings: [...warnings, 'blocked-or-login-page'] };
  }
  if (text.length >= 280) {
    return { status: 'complete', accepted: true, warnings };
  }
  if (text.length >= 80) {
    return { status: 'partial', accepted: true, warnings: [...warnings, 'short-content'] };
  }
  return { status: 'link-only', accepted: false, warnings: [...warnings, 'insufficient-readable-content'] };
}

export function applyCaptureQuality(document) {
  const quality = assessCaptureQuality(document);
  return {
    ...document,
    status: quality.status,
    diagnostics: {
      ...(document?.diagnostics || {}),
      warnings: quality.warnings,
    },
  };
}
