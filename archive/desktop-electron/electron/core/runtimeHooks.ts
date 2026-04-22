import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeApiBaseUrl, safeUrlJoin } from './urlUtils';
import type { HookContext, HookDefinition, RuntimeAdapter } from './runtimeTypes';

const execAsync = promisify(exec);

const hooks = new Map<string, HookDefinition>();

const matchesHook = (hook: HookDefinition, context: HookContext): boolean => {
  if (hook.enabled === false) return false;
  if (!hook.matcher) return true;
  const haystack = JSON.stringify(context.payload);
  return haystack.includes(hook.matcher);
};

const interpolate = (template: string, context: HookContext): string => {
  return template.replace(/\$ARGUMENTS/g, JSON.stringify(context.payload));
};

const runPromptHook = async (hook: HookDefinition, context: HookContext, llm?: {
  apiKey: string;
  baseURL: string;
  model: string;
}): Promise<string> => {
  if (!llm || !hook.prompt) {
    return '';
  }
  const response = await fetch(safeUrlJoin(normalizeApiBaseUrl(llm.baseURL), '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a runtime hook. Respond briefly and structurally.' },
        { role: "user", content: interpolate(hook.prompt, context) },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Hook prompt failed: ${response.status}`);
  }
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return String(data?.choices?.[0]?.message?.content || '').trim();
};

export const registerRuntimeHook = (hook: HookDefinition): HookDefinition => {
  hooks.set(hook.id, {
    ...hook,
    enabled: hook.enabled !== false,
  });
  return hooks.get(hook.id)!;
};

export const unregisterRuntimeHook = (hookId: string): void => {
  hooks.delete(hookId);
};

export const listRuntimeHooks = (): HookDefinition[] => Array.from(hooks.values());

export const executeRuntimeHooks = async (params: {
  event: HookDefinition["event"];
  context: HookContext;
  adapter?: RuntimeAdapter;
  llm?: {
    apiKey: string;
    baseURL: string;
    model: string;
  };
}): Promise<void> => {
  const matchingHooks = listRuntimeHooks().filter((hook) => hook.event === params.event && matchesHook(hook, params.context));
  for (const hook of matchingHooks) {
    params.adapter?.onEvent({ type: 'hook_start', hookId: hook.id, event: hook.event });
    try {
      let output = '';
      if (hook.type === "command" && hook.command) {
        const executed = await execAsync(interpolate(hook.command, params.context), {
          timeout: hook.timeoutMs || 20_000,
          shell: '/bin/zsh',
        });
        output = `${executed.stdout || ''}${executed.stderr || ''}`.trim();
      } else if (hook.type === "http" && hook.url) {
        const response = await fetch(hook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(hook.headers || {}),
          },
          body: JSON.stringify(params.context),
        });
        output = await response.text();
      } else if ((hook.type === "prompt" || hook.type === "agent") && hook.prompt) {
        output = await runPromptHook(hook, params.context, params.llm);
      }
      params.adapter?.onEvent({ type: 'hook_end', hookId: hook.id, event: hook.event, success: true, output });
    } catch (error) {
      params.adapter?.onEvent({
        type: 'hook_end',
        hookId: hook.id,
        event: hook.event,
        success: false,
        output: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
