import type { ToolDefinition, ToolResult } from '../toolRegistry';

export interface BuiltinToolFactoryContext {
    chatService?: any;
    skillManager?: any;
    onSkillActivated?: (payload: { name: string; description: string }) => void;
    workspaceRootOverride?: string;
}

export type BuiltinToolPack = 'redclaw' | 'knowledge' | 'chatroom' | 'diagnostics' | 'full';
export type BuiltinToolVisibility = 'public' | 'developer' | 'internal';
export type BuiltinToolRequiredContext = 'chatService' | null;

export interface BuiltinToolDescriptor {
    name: string;
    displayName: string;
    description: string;
    kind: string;
    contexts: BuiltinToolPack[];
    visibility: BuiltinToolVisibility;
    requiresContext: BuiltinToolRequiredContext;
    preconditions?: string[];
    successSignal?: string;
    failureSignal?: string;
    artifactOutput?: string[];
    retryPolicy?: 'never' | 'safe-retry' | 'manual';
    requiresConfirmation?: boolean;
    create: (context: BuiltinToolFactoryContext) => ToolDefinition<unknown, ToolResult> | null;
}

export interface CreateBuiltinToolOptions extends BuiltinToolFactoryContext {
    pack?: BuiltinToolPack;
}

const builtinToolDescriptors = new Map<string, BuiltinToolDescriptor>();
const builtinToolOrder: string[] = [];

export const registerBuiltinToolDescriptor = (descriptor: BuiltinToolDescriptor): void => {
    if (!builtinToolDescriptors.has(descriptor.name)) {
        builtinToolOrder.push(descriptor.name);
    }
    builtinToolDescriptors.set(descriptor.name, descriptor);
};

export const listBuiltinToolDescriptors = (): BuiltinToolDescriptor[] => {
    return builtinToolOrder
        .map((name) => builtinToolDescriptors.get(name))
        .filter((descriptor): descriptor is BuiltinToolDescriptor => Boolean(descriptor));
};

export const toolDescriptorMatchesPack = (
    descriptor: BuiltinToolDescriptor,
    pack: BuiltinToolPack = 'full',
): boolean => {
    if (pack === 'full') {
        return true;
    }
    return descriptor.contexts.includes(pack);
};

export const getBuiltinToolDescriptor = (name: string): BuiltinToolDescriptor | null => {
    return builtinToolDescriptors.get(name) || null;
};

export const createBuiltinToolInstances = (options: CreateBuiltinToolOptions = {}): ToolDefinition<unknown, ToolResult>[] => {
    const { pack = 'full', ...context } = options;
    return listBuiltinToolDescriptors()
        .filter((descriptor) => toolDescriptorMatchesPack(descriptor, pack))
        .map((descriptor) => descriptor.create(context))
        .filter((tool): tool is ToolDefinition<unknown, ToolResult> => Boolean(tool));
};
