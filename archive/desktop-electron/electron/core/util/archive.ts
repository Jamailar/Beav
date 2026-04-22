import { exec } from 'child_process';
import * as path from 'path';
import * as util from 'util';

const execAsync = util.promisify(exec);

export namespace Archive {
  export async function extractZip(zipPath: string, destDir: string) {
    if (process.platform === "win32") {
      const winZipPath = path.resolve(zipPath);
      const winDestDir = path.resolve(destDir);
      const cmd = `powershell -NoProfile -NonInteractive -Command "$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -Path '${winZipPath}' -DestinationPath '${winDestDir}' -Force"`;
      await execAsync(cmd);
    } else {
      await execAsync(`unzip -o -q "${zipPath}" -d "${destDir}"`);
    }
  }
}
