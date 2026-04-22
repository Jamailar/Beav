import path from 'node:path';

function normalize(p: string): string {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function withTrailingSep(p: string): string {
    return p.endsWith(path.sep) ? p : `${p}${path.sep}`;
}

export function isPathInWorkspace(targetPath: string, workspaceRoot: string): boolean {
    const normalizedRoot = normalize(workspaceRoot);
    const normalizedTarget = normalize(targetPath);
    return (
        normalizedTarget === normalizedRoot ||
        normalizedTarget.startsWith(withTrailingSep(normalizedRoot))
    );
}

export function resolvePathInWorkspace(inputPath: string, workspaceRoot: string): string {
    const resolved = path.isAbsolute(inputPath)
        ? path.resolve(inputPath)
        : path.resolve(workspaceRoot, inputPath);

    if (!isPathInWorkspace(resolved, workspaceRoot)) {
        throw new Error(`Path is outside workspace: ${resolved}`);
    }

    return resolved;
}

