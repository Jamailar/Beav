import { promptLoader } from './loader';

export type PromptTemplateVars = Record<string, unknown>;

const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}|\{([a-zA-Z0-9_.-]+)\}/g;

export function loadPrompt(relativePath: string, fallback = ''): string {
    const loaded = promptLoader.load(relativePath);
    if (loaded) {
        return loaded;
    }
    return fallback;
}

export function renderPrompt(template: string, vars: PromptTemplateVars = {}): string {
    if (!template) {
        return '';
    }

    return template.replace(PLACEHOLDER_REGEX, (match, moustacheKey, braceKey) => {
        const key = String(moustacheKey || braceKey || '').trim();
        if (!key) {
            return match;
        }
        if (!Object.prototype.hasOwnProperty.call(vars, key)) {
            return match;
        }

        const value = vars[key];
        if (value === undefined || value === null) {
            return '';
        }
        return String(value);
    });
}

export function loadAndRenderPrompt(relativePath: string, vars: PromptTemplateVars = {}, fallback = ''): string {
    const template = loadPrompt(relativePath, fallback);
    return renderPrompt(template, vars);
}
