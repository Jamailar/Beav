import { spawn, type ChildProcessWithoutNullStreams, exec } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import * as util from "util";
import { Global } from "../global";
import { Log } from "../util/log";
import { Instance } from "../instance";
import { Filesystem } from "../util/filesystem";
import { Flag } from "../flag/flag";
import { Archive } from "../util/archive";
import { which } from "../util/which";

const execAsync = util.promisify(exec);

export namespace LSPServer {
  const log = Log.create({ service: "lsp.server" });

  export interface Handle {
    process: ChildProcessWithoutNullStreams;
    initialization?: Record<string, any>;
  }

  type RootFunction = (file: string) => Promise<string | undefined>;

  const NearestRoot = (includePatterns: string[], excludePatterns?: string[]): RootFunction => {
    return async (file) => {
      if (excludePatterns) {
        const excludedFiles = Filesystem.up({
          targets: excludePatterns,
          start: path.dirname(file),
          stop: Instance.directory,
        });
        const excluded = await excludedFiles.next();
        await excludedFiles.return();
        if (excluded.value) return undefined;
      }
      const files = Filesystem.up({
        targets: includePatterns,
        start: path.dirname(file),
        stop: Instance.directory,
      });
      const first = await files.next();
      await files.return();
      if (!first.value) return Instance.directory;
      return path.dirname(first.value);
    };
  };

  export interface Info {
    id: string;
    extensions: string[];
    global?: boolean;
    root: RootFunction;
    spawn(root: string): Promise<Handle | undefined>;
  }

  export const Typescript: Info = {
    id: "typescript",
    root: NearestRoot(
      ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"],
      ["deno.json", "deno.jsonc"],
    ),
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    async spawn(root) {
      let tsserver: string | undefined;
      try {
        tsserver = require.resolve("typescript/lib/tsserver.js", { paths: [Instance.directory, root] });
      } catch {}
      
      log.info("typescript server", { tsserver });
      if (!tsserver) return;

      const proc = spawn(process.execPath, ["x", "typescript-language-server", "--stdio"], {
        cwd: root,
        env: { ...process.env },
      });
      return {
        process: proc,
        initialization: {
          tsserver: {
            path: tsserver,
          },
        },
      };
    },
  };

  export const Deno: Info = {
    id: "deno",
    root: async (file) => {
      const files = Filesystem.up({
        targets: ["deno.json", "deno.jsonc"],
        start: path.dirname(file),
        stop: Instance.directory,
      });
      const first = await files.next();
      await files.return();
      if (!first.value) return undefined;
      return path.dirname(first.value);
    },
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
    async spawn(root) {
      const deno = await which("deno");
      if (!deno) {
        log.info("deno not found, please install deno first");
        return;
      }
      return {
        process: spawn(deno, ["lsp"], {
          cwd: root,
        }),
      };
    },
  };

  export const ESLint: Info = {
    id: "eslint",
    root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"],
    async spawn(root) {
        // Simplified ESLint spawning - assumes vscode-eslint-language-server is available or installs it
        // This is a complex part in original code, simplifying for portability
        return undefined; // Placeholder
    }
  };

  export const Pyright: Info = {
    id: "pyright",
    extensions: [".py", ".pyi"],
    root: NearestRoot(["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"]),
    async spawn(root) {
      let binary = await which("pyright-langserver");
      const args = [];
      if (!binary) {
          // Try to find in local node_modules
          try {
            const js = require.resolve("pyright/dist/pyright-langserver.js", { paths: [Global.Path.bin] });
             binary = process.execPath;
             args.push(js);
          } catch {
             // Install if needed
             if (!Flag.OPENCODE_DISABLE_LSP_DOWNLOAD) {
                 await execAsync(`npm install pyright`, { cwd: Global.Path.bin });
                 try {
                     const js = require.resolve("pyright/dist/pyright-langserver.js", { paths: [Global.Path.bin] });
                     binary = process.execPath;
                     args.push(js);
                 } catch {}
             }
          }
      }
      
      if (!binary) return undefined;

      args.push("--stdio");
      
      const initialization: Record<string, string> = {};
      // Venv detection logic omitted for brevity, can be added back
      
      const proc = spawn(binary, args, {
        cwd: root,
        env: { ...process.env },
      });
      return {
        process: proc,
        initialization,
      };
    },
  };

  export const RustAnalyzer: Info = {
    id: "rust",
    root: async (root) => {
      // Simplified root detection
      return NearestRoot(["Cargo.toml"])(root);
    },
    extensions: [".rs"],
    async spawn(root) {
      const bin = await which("rust-analyzer");
      if (!bin) {
        log.info("rust-analyzer not found in path, please install it");
        return;
      }
      return {
        process: spawn(bin, {
          cwd: root,
        }),
      };
    },
  };

   export const Gopls: Info = {
    id: "gopls",
    root: async (file) => {
       return NearestRoot(["go.mod", "go.sum"])(file);
    },
    extensions: [".go"],
    async spawn(root) {
      let bin = await which("gopls");
      if (!bin) {
         // Install logic omitted
         return;
      }
      return {
        process: spawn(bin, {
          cwd: root,
        }),
      };
    },
  };
}
