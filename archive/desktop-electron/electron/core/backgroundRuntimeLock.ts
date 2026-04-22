import fs from 'node:fs/promises';
import path from 'node:path';

export type BackgroundRuntimeLockRecord = {
    ownerId: string;
    pid: number;
    acquiredAt: number;
};

export type BackgroundLockAcquireResult = {
    acquired: boolean;
    blockedBy?: string;
};

function isProcessRunning(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function readLock(lockPath: string): Promise<BackgroundRuntimeLockRecord | null> {
    try {
        const raw = await fs.readFile(lockPath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<BackgroundRuntimeLockRecord>;
        if (
            typeof parsed?.ownerId !== 'string'
            || typeof parsed?.pid !== 'number'
            || typeof parsed?.acquiredAt !== 'number'
        ) {
            return null;
        }
        return {
            ownerId: parsed.ownerId,
            pid: parsed.pid,
            acquiredAt: parsed.acquiredAt,
        };
    } catch {
        return null;
    }
}

async function tryCreateExclusive(lockPath: string, record: BackgroundRuntimeLockRecord): Promise<boolean> {
    const body = JSON.stringify(record, null, 2);
    try {
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
        await fs.writeFile(lockPath, body, { flag: 'wx' });
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'EEXIST') {
            return false;
        }
        throw error;
    }
}

export async function tryAcquireBackgroundRuntimeLock(lockPath: string, ownerId: string): Promise<BackgroundLockAcquireResult> {
    const record: BackgroundRuntimeLockRecord = {
        ownerId,
        pid: process.pid,
        acquiredAt: Date.now(),
    };

    if (await tryCreateExclusive(lockPath, record)) {
        return { acquired: true };
    }

    const existing = await readLock(lockPath);
    if (existing?.ownerId === ownerId) {
        if (existing.pid !== process.pid) {
            await fs.writeFile(lockPath, JSON.stringify(record, null, 2), 'utf-8');
        }
        return { acquired: true };
    }

    if (existing && isProcessRunning(existing.pid)) {
        return {
            acquired: false,
            blockedBy: existing.ownerId,
        };
    }

    await fs.unlink(lockPath).catch(() => {});
    if (await tryCreateExclusive(lockPath, record)) {
        return { acquired: true };
    }

    const current = await readLock(lockPath);
    return {
        acquired: false,
        blockedBy: current?.ownerId,
    };
}

export async function releaseBackgroundRuntimeLock(lockPath: string, ownerId: string): Promise<void> {
    const existing = await readLock(lockPath);
    if (!existing || existing.ownerId !== ownerId) {
        return;
    }
    await fs.unlink(lockPath).catch(() => {});
}
