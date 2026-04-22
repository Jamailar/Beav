import { exec } from 'child_process';
import * as util from 'util';
import * as path from 'path';

const execAsync = util.promisify(exec);

export async function which(command: string): Promise<string | undefined> {
    try {
        const cmd = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
        const { stdout } = await execAsync(cmd);
        const lines = stdout.split('\n').filter(line => line.trim().length > 0);
        if (lines.length > 0) {
            return lines[0].trim();
        }
        return undefined;
    } catch {
        return undefined;
    }
}
