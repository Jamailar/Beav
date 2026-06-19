export const TARGET_UNSUPPORTED_BROWSER_NAME = 'Chrome';
export const TARGET_UNSUPPORTED_COMMAND_ERROR_CODE = -32601;
export const TARGET_UNSUPPORTED_COMMAND_MESSAGE_TEMPLATE = 'Chrome does not support command "<type>".';
export const TARGET_UNKNOWN_NATIVE_METHOD_ERROR_CODE = -1;
export const XWOW_UNKNOWN_NATIVE_METHOD_ERROR_CODE = -32601;

export function normalizeUnsupportedCommand(action = {}) {
  const unsupportedMethod = firstString(action.unsupportedMethod, action.method, action.command, action.action, action.requestedType, action.typeName, action.name) || 'unknown';
  return {
    unsupportedMethod,
    browserName: firstString(action.browserName, action.backendName) || TARGET_UNSUPPORTED_BROWSER_NAME,
  };
}

export function unsupportedBrowserCommandError(action = {}) {
  const normalized = normalizeUnsupportedCommand(action);
  const error = new Error(`${normalized.browserName} does not support command "${normalized.unsupportedMethod}".`);
  error.code = TARGET_UNSUPPORTED_COMMAND_ERROR_CODE;
  error.method = normalized.unsupportedMethod;
  error.unsupportedMethod = normalized.unsupportedMethod;
  error.browserName = normalized.browserName;
  return error;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
