import { getElectronIpcTransport } from './electronTransport';

const explicitCommandRoutes: Record<string, string> = {
  spaces_list: 'spaces:list',
  advisors_list: 'advisors:list',
  advisors_list_templates: 'advisors:list-templates',
  knowledge_list: 'knowledge:list',
  knowledge_list_youtube: 'knowledge:list-youtube',
  knowledge_docs_list: 'knowledge:docs:list',
  knowledge_list_page: 'knowledge:list-page',
  knowledge_get_item_detail: 'knowledge:get-item-detail',
  knowledge_get_index_status: 'knowledge:get-index-status',
  knowledge_rebuild_catalog: 'knowledge:rebuild-catalog',
  knowledge_open_index_root: 'knowledge:open-index-root',
  redclaw_runner_status: 'redclaw:runner-status',
};

function toFileUrl(pathValue: string): string {
  const normalized = String(pathValue || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  return `file://${encodeURI(normalized)}`;
}

export async function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown> | undefined,
): Promise<T> {
  const transport = getElectronIpcTransport();

  if (command === 'ipc_invoke') {
    const channel = String(args?.channel || '').trim();
    return transport.invoke<T>(channel, args?.payload);
  }

  if (command === 'ipc_send') {
    const channel = String(args?.channel || '').trim();
    transport.send(channel, args?.payload);
    return undefined as T;
  }

  const mappedChannel = explicitCommandRoutes[command] || command;
  const normalizedArgs = args && Object.keys(args).length > 0 ? args : undefined;
  return transport.invoke<T>(mappedChannel, normalizedArgs);
}

export function convertFileSrc(pathValue: string): string {
  return toFileUrl(pathValue);
}
