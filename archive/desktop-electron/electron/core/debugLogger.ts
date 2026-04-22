import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';

export type DebugLogLevel = 'info' | 'warn' | 'error';

interface DebugLogEntry {
    ts: string;
    level: DebugLogLevel;
    scope: string;
    message: string;
    data?: unknown;
}

let debugLoggingEnabled = false;
let consoleBridgeInstalled = false;

const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

const safeSerialize = (value: unknown): string => {
    try {
        return JSON.stringify(value, (_key, currentValue) => {
            if (currentValue instanceof Error) {
                return {
                    name: currentValue.name,
                    message: currentValue.message,
                    stack: currentValue.stack,
                };
            }
            return currentValue;
        });
    } catch (error) {
        return JSON.stringify({
            serializationError: error instanceof Error ? error.message : String(error),
            fallback: String(value),
        });
    }
};

const getLogDir = (): string => {
    return path.join(app.getPath('userData'), 'logs');
};

const getLogFilePath = (date = new Date()): string => {
    const dateTag = date.toISOString().slice(0, 10);
    return path.join(getLogDir(), `debug-${dateTag}.log`);
};

const appendLogLine = (entry: DebugLogEntry): void => {
    if (!debugLoggingEnabled) {
        return;
    }

    try {
        fs.mkdirSync(getLogDir(), { recursive: true });
        fs.appendFileSync(getLogFilePath(new Date(entry.ts)), `${safeSerialize(entry)}\n`, 'utf8');
    } catch (error) {
        originalConsole.error('[debug-logger] failed to append log:', error);
    }
};

export const setDebugLoggingEnabled = (enabled: boolean): void => {
    const nextValue = Boolean(enabled);
    debugLoggingEnabled = nextValue;
    if (nextValue) {
        appendLogLine({
            ts: new Date().toISOString(),
            level: 'info',
            scope: 'debug-logger',
            message: 'debug logging enabled',
        });
    } else {
        originalConsole.log('[debug-logger] disabled');
    }
};

export const isDebugLoggingEnabled = (): boolean => debugLoggingEnabled;

export const logDebugEvent = (
    scope: string,
    level: DebugLogLevel,
    message: string,
    data?: unknown,
): void => {
    appendLogLine({
        ts: new Date().toISOString(),
        level,
        scope,
        message,
        data,
    });
};

export const installDebugConsoleBridge = (): void => {
    if (consoleBridgeInstalled) {
        return;
    }
    consoleBridgeInstalled = true;

    console.log = (...args: unknown[]) => {
        originalConsole.log(...args);
        if (debugLoggingEnabled) {
            logDebugEvent('console', 'info', String(args[0] ?? ''), args.slice(1));
        }
    };

    console.warn = (...args: unknown[]) => {
        originalConsole.warn(...args);
        if (debugLoggingEnabled) {
            logDebugEvent('console', 'warn', String(args[0] ?? ''), args.slice(1));
        }
    };

    console.error = (...args: unknown[]) => {
        originalConsole.error(...args);
        if (debugLoggingEnabled) {
            logDebugEvent('console', 'error', String(args[0] ?? ''), args.slice(1));
        }
    };
};

export const getDebugLogDirectory = (): string => getLogDir();

export const getRecentDebugLogs = (limit = 200): string[] => {
    const logDir = getLogDir();
    if (!fs.existsSync(logDir)) {
        return [];
    }

    const files = fs.readdirSync(logDir)
        .filter((fileName) => fileName.startsWith('debug-') && fileName.endsWith('.log'))
        .sort()
        .reverse();

    const lines: string[] = [];
    for (const fileName of files) {
        const filePath = path.join(logDir, fileName);
        const content = fs.readFileSync(filePath, 'utf8');
        const currentLines = content.split('\n').filter(Boolean);
        lines.unshift(...currentLines.slice(-limit));
        if (lines.length >= limit) {
            break;
        }
    }

    return lines.slice(-limit);
};

export const openDebugLogDirectory = async (): Promise<{ success: boolean; error?: string; path: string }> => {
    const targetDir = getLogDir();
    try {
        fs.mkdirSync(targetDir, { recursive: true });
        const result = await shell.openPath(targetDir);
        if (result) {
            return { success: false, error: result, path: targetDir };
        }
        return { success: true, path: targetDir };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            path: targetDir,
        };
    }
};
