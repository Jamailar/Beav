import { useEffect, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { resolveAppDialog, subscribeAppDialogs, type AppDialogRequest } from '../utils/appDialogs';

export function AppDialogsHost() {
    const [request, setRequest] = useState<AppDialogRequest | null>(null);

    useEffect(() => {
        return subscribeAppDialogs(setRequest);
    }, []);

    return (
        <ConfirmDialog
            open={Boolean(request)}
            title={request?.title || '提示'}
            description={request?.description || ''}
            confirmLabel={request?.confirmLabel || '确认'}
            cancelLabel={request?.kind === 'alert' ? '' : (request?.cancelLabel || '取消')}
            tone={request?.tone || 'default'}
            onCancel={() => resolveAppDialog(false)}
            onConfirm={() => resolveAppDialog(true)}
            hideCancel={request?.kind === 'alert'}
        />
    );
}
