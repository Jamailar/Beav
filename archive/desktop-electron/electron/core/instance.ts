import * as path from 'path';

export const Instance = {
    directory: process.cwd(), // Default to CWD, should be set on startup
    worktree: process.cwd(),

    init(dir: string) {
        // @ts-ignore
        this.directory = dir;
        // @ts-ignore
        this.worktree = dir;
    }
};
