import * as path from 'path';
import * as os from 'os';

export const Global = {
    Path: {
        bin: path.join(os.homedir(), '.opencode', 'bin'),
    }
};
