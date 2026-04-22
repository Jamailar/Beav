export type AppDialogTone = 'default' | 'danger';
type DialogKind = 'alert' | 'confirm';

export interface AppDialogRequest {
    id: string;
    kind: DialogKind;
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: AppDialogTone;
}

type DialogListener = (request: AppDialogRequest | null) => void;

let currentRequest: AppDialogRequest | null = null;
let resolver: ((value: boolean) => void) | null = null;
const listeners = new Set<DialogListener>();

function emit() {
    for (const listener of listeners) {
        listener(currentRequest);
    }
}

function openDialog(request: AppDialogRequest): Promise<boolean> {
    currentRequest = request;
    emit();
    return new Promise<boolean>((resolve) => {
        resolver = resolve;
    });
}

export function subscribeAppDialogs(listener: DialogListener): () => void {
    listeners.add(listener);
    listener(currentRequest);
    return () => {
        listeners.delete(listener);
    };
}

export function resolveAppDialog(confirmed: boolean): void {
    const nextResolver = resolver;
    resolver = null;
    currentRequest = null;
    emit();
    nextResolver?.(confirmed);
}

export function appAlert(
    description: string,
    options?: { title?: string; confirmLabel?: string; tone?: AppDialogTone }
): Promise<void> {
    return openDialog({
        id: `app-dialog-${Date.now()}`,
        kind: 'alert',
        title: options?.title || '提示',
        description: String(description || ''),
        confirmLabel: options?.confirmLabel || '知道了',
        tone: options?.tone || 'default',
    }).then(() => undefined);
}

export function appConfirm(
    description: string,
    options?: {
        title?: string;
        confirmLabel?: string;
        cancelLabel?: string;
        tone?: AppDialogTone;
    }
): Promise<boolean> {
    return openDialog({
        id: `app-dialog-${Date.now()}`,
        kind: 'confirm',
        title: options?.title || '确认操作',
        description: String(description || ''),
        confirmLabel: options?.confirmLabel || '确认',
        cancelLabel: options?.cancelLabel || '取消',
        tone: options?.tone || 'default',
    });
}
