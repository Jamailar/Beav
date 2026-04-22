import * as fs from 'fs/promises';
import * as path from 'path';
import { realpathSync } from 'fs';

export namespace Filesystem {
    export const exists = async (p: string): Promise<boolean> => {
        try {
            await fs.access(p);
            return true;
        } catch {
            return false;
        }
    };

    export const isDir = async (p: string): Promise<boolean> => {
        try {
            const stat = await fs.stat(p);
            return stat.isDirectory();
        } catch {
            return false;
        }
    };

    /**
     * On Windows, normalize a path to its canonical casing using the filesystem.
     */
    export function normalizePath(p: string): string {
        if (process.platform !== 'win32') return p;
        try {
            return realpathSync.native(p);
        } catch {
            return p;
        }
    }

    export function overlaps(a: string, b: string): boolean {
        const relA = path.relative(a, b);
        const relB = path.relative(b, a);
        return !relA || !relA.startsWith('..') || !relB || !relB.startsWith('..');
    }

    export function contains(parent: string, child: string): boolean {
        const rel = path.relative(parent, child);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
    }

    export async function findUp(target: string, start: string, stop?: string): Promise<string[]> {
        let current = start;
        const result: string[] = [];
        while (true) {
            const search = path.join(current, target);
            if (await exists(search)) result.push(search);
            if (stop === current) break;
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        return result;
    }

    export async function* up(options: { targets: string[]; start: string; stop?: string }) {
        const { targets, start, stop } = options;
        let current = start;
        while (true) {
            for (const target of targets) {
                const search = path.join(current, target);
                if (await exists(search)) yield search;
            }
            if (stop === current) break;
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
    }
}
