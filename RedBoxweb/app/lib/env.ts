const syncRequiredEnvKeys = [
    'GITHUB_OWNER',
    'GITHUB_REPO',
    'OSS_REGION',
    'OSS_BUCKET',
    'OSS_ACCESS_KEY_ID',
    'OSS_ACCESS_KEY_SECRET',
    'OSS_PUBLIC_BASE_URL',
    'SYNC_AUTH_TOKEN',
] as const;

export interface DiagnosticsEnv {
    DIAGNOSTICS_STORAGE_DIR: string;
}

export interface PublicEnv {
    OSS_PUBLIC_BASE_URL: string;
}

export interface SyncEnv extends PublicEnv {
    GITHUB_OWNER: string;
    GITHUB_REPO: string;
    GITHUB_TOKEN?: string;
    OSS_REGION: string;
    OSS_BUCKET: string;
    OSS_ACCESS_KEY_ID: string;
    OSS_ACCESS_KEY_SECRET: string;
    OSS_PUBLIC_BASE_URL: string;
    SYNC_AUTH_TOKEN: string;
}

function readRawEnv() {
    return {
        GITHUB_OWNER: process.env.GITHUB_OWNER,
        GITHUB_REPO: process.env.GITHUB_REPO,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
        OSS_REGION: process.env.OSS_REGION,
        OSS_BUCKET: process.env.OSS_BUCKET,
        OSS_ACCESS_KEY_ID: process.env.OSS_ACCESS_KEY_ID,
        OSS_ACCESS_KEY_SECRET: process.env.OSS_ACCESS_KEY_SECRET,
        OSS_PUBLIC_BASE_URL: process.env.OSS_PUBLIC_BASE_URL,
        SYNC_AUTH_TOKEN: process.env.SYNC_AUTH_TOKEN,
        DIAGNOSTICS_STORAGE_DIR: process.env.DIAGNOSTICS_STORAGE_DIR,
    } satisfies Record<string, string | undefined>;
}

export function getOptionalPublicEnv(): PublicEnv | null {
    const values = readRawEnv();
    if (!String(values.OSS_PUBLIC_BASE_URL || '').trim()) {
        return null;
    }

    return {
        OSS_PUBLIC_BASE_URL: values.OSS_PUBLIC_BASE_URL!,
    };
}

export function getPublicEnv(): PublicEnv {
    const env = getOptionalPublicEnv();
    if (!env) {
        throw new Error('Missing required environment variables: OSS_PUBLIC_BASE_URL');
    }
    return env;
}

export function listMissingSyncEnvKeys() {
    const values = readRawEnv();
    return syncRequiredEnvKeys.filter((key) => !String(values[key] || '').trim());
}

export function getOptionalSyncEnv(): SyncEnv | null {
    const values = readRawEnv();
    const missing = listMissingSyncEnvKeys();
    if (missing.length > 0) {
        return null;
    }

    return {
        GITHUB_OWNER: values.GITHUB_OWNER!,
        GITHUB_REPO: values.GITHUB_REPO!,
        GITHUB_TOKEN: values.GITHUB_TOKEN,
        OSS_REGION: values.OSS_REGION!,
        OSS_BUCKET: values.OSS_BUCKET!,
        OSS_ACCESS_KEY_ID: values.OSS_ACCESS_KEY_ID!,
        OSS_ACCESS_KEY_SECRET: values.OSS_ACCESS_KEY_SECRET!,
        OSS_PUBLIC_BASE_URL: values.OSS_PUBLIC_BASE_URL!,
        SYNC_AUTH_TOKEN: values.SYNC_AUTH_TOKEN!,
    };
}

export function getSyncEnv(): SyncEnv {
    const values = {
        GITHUB_OWNER: process.env.GITHUB_OWNER,
        GITHUB_REPO: process.env.GITHUB_REPO,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
        OSS_REGION: process.env.OSS_REGION,
        OSS_BUCKET: process.env.OSS_BUCKET,
        OSS_ACCESS_KEY_ID: process.env.OSS_ACCESS_KEY_ID,
        OSS_ACCESS_KEY_SECRET: process.env.OSS_ACCESS_KEY_SECRET,
        OSS_PUBLIC_BASE_URL: process.env.OSS_PUBLIC_BASE_URL,
        SYNC_AUTH_TOKEN: process.env.SYNC_AUTH_TOKEN,
    } satisfies Record<string, string | undefined>;

    const missing = syncRequiredEnvKeys.filter((key) => !String(values[key] || '').trim());
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    return {
        GITHUB_OWNER: values.GITHUB_OWNER!,
        GITHUB_REPO: values.GITHUB_REPO!,
        GITHUB_TOKEN: values.GITHUB_TOKEN,
        OSS_REGION: values.OSS_REGION!,
        OSS_BUCKET: values.OSS_BUCKET!,
        OSS_ACCESS_KEY_ID: values.OSS_ACCESS_KEY_ID!,
        OSS_ACCESS_KEY_SECRET: values.OSS_ACCESS_KEY_SECRET!,
        OSS_PUBLIC_BASE_URL: values.OSS_PUBLIC_BASE_URL!,
        SYNC_AUTH_TOKEN: values.SYNC_AUTH_TOKEN!,
    };
}

export function getOptionalDiagnosticsEnv(): DiagnosticsEnv | null {
    const storageDir = String(process.env.DIAGNOSTICS_STORAGE_DIR || '').trim();
    if (!storageDir) {
        return null;
    }
    return {
        DIAGNOSTICS_STORAGE_DIR: storageDir,
    };
}

export function getDiagnosticsEnv(): DiagnosticsEnv {
    const env = getOptionalDiagnosticsEnv();
    if (!env) {
        throw new Error('Missing required environment variables: DIAGNOSTICS_STORAGE_DIR');
    }
    return env;
}
