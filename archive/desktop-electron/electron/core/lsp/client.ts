import { Bus } from "../bus";
import * as path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types";
import { Log } from "../util/log";
import { LANGUAGE_EXTENSIONS } from "./language";
import * as fs from "fs/promises";
import { withTimeout } from "../util/timeout";
import { Instance } from "../instance";
import { Filesystem } from "../util/filesystem";
import type { LSPServer } from "./server";

const DIAGNOSTICS_DEBOUNCE_MS = 150;

export namespace LSPClient {
  const log = Log.create({ service: "lsp.client" });

  export type Info = NonNullable<Awaited<ReturnType<typeof create>>>;

  export type Diagnostic = VSCodeDiagnostic;

  export const Event = {
    Diagnostics: {
      type: "lsp.client.diagnostics",
    },
  };

  export async function create(input: { serverID: string; server: LSPServer.Handle; root: string }) {
    const l = log.clone().tag("serverID", input.serverID);
    l.info("starting client");

    const connection = createMessageConnection(
      new StreamMessageReader(input.server.process.stdout as any),
      new StreamMessageWriter(input.server.process.stdin as any),
    );

    const diagnostics = new Map<string, Diagnostic[]>();
    connection.onNotification("textDocument/publishDiagnostics", (params: any) => {
      const filePath = Filesystem.normalizePath(fileURLToPath(params.uri));
      l.info("textDocument/publishDiagnostics", {
        path: filePath,
        count: params.diagnostics.length,
      });
      const exists = diagnostics.has(filePath);
      diagnostics.set(filePath, params.diagnostics);
      if (!exists && input.serverID === "typescript") return;
      Bus.emit(Event.Diagnostics.type, { path: filePath, serverID: input.serverID });
    });
    connection.onRequest("window/workDoneProgress/create", (params: any) => {
      l.info("window/workDoneProgress/create", params);
      return null;
    });
    connection.onRequest("workspace/configuration", async () => {
      // Return server initialization options
      return [input.server.initialization ?? {}];
    });
    connection.onRequest("client/registerCapability", async () => {});
    connection.onRequest("client/unregisterCapability", async () => {});
    connection.onRequest("workspace/workspaceFolders", async () => [
      {
        name: "workspace",
        uri: pathToFileURL(input.root).href,
      },
    ]);
    connection.listen();

    l.info("sending initialize");
    await withTimeout(
      connection.sendRequest("initialize", {
        rootUri: pathToFileURL(input.root).href,
        processId: input.server.process.pid,
        workspaceFolders: [
          {
            name: "workspace",
            uri: pathToFileURL(input.root).href,
          },
        ],
        initializationOptions: {
          ...input.server.initialization,
        },
        capabilities: {
          window: {
            workDoneProgress: true,
          },
          workspace: {
            configuration: true,
            didChangeWatchedFiles: {
              dynamicRegistration: true,
            },
          },
          textDocument: {
            synchronization: {
              didOpen: true,
              didChange: true,
            },
            publishDiagnostics: {
              versionSupport: true,
            },
          },
        },
      }),
      45_000,
    ).catch((err) => {
      l.error("initialize error", { error: err });
      throw new Error(`LSPInitializeError: ${input.serverID}`);
    });

    await connection.sendNotification("initialized", {});

    if (input.server.initialization) {
      await connection.sendNotification("workspace/didChangeConfiguration", {
        settings: input.server.initialization,
      });
    }

    const files: {
      [path: string]: number;
    } = {};

    const result = {
      root: input.root,
      get serverID() {
        return input.serverID;
      },
      get connection() {
        return connection;
      },
      notify: {
        async open(input: { path: string }) {
          input.path = path.isAbsolute(input.path) ? input.path : path.resolve(Instance.directory, input.path);
          const text = await fs.readFile(input.path, "utf-8");
          const extension = path.extname(input.path);
          const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext";

          const version = files[input.path];
          if (version !== undefined) {
            log.info("workspace/didChangeWatchedFiles", input);
            await connection.sendNotification("workspace/didChangeWatchedFiles", {
              changes: [
                {
                  uri: pathToFileURL(input.path).href,
                  type: 2, // Changed
                },
              ],
            });

            const next = version + 1;
            files[input.path] = next;
            log.info("textDocument/didChange", {
              path: input.path,
              version: next,
            });
            await connection.sendNotification("textDocument/didChange", {
              textDocument: {
                uri: pathToFileURL(input.path).href,
                version: next,
              },
              contentChanges: [{ text }],
            });
            return;
          }

          log.info("workspace/didChangeWatchedFiles", input);
          await connection.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [
              {
                uri: pathToFileURL(input.path).href,
                type: 1, // Created
              },
            ],
          });

          log.info("textDocument/didOpen", input);
          diagnostics.delete(input.path);
          await connection.sendNotification("textDocument/didOpen", {
            textDocument: {
              uri: pathToFileURL(input.path).href,
              languageId,
              version: 0,
              text,
            },
          });
          files[input.path] = 0;
          return;
        },
      },
      get diagnostics() {
        return diagnostics;
      },
      async waitForDiagnostics(input: { path: string }) {
        const normalizedPath = Filesystem.normalizePath(
          path.isAbsolute(input.path) ? input.path : path.resolve(Instance.directory, input.path),
        );
        log.info("waiting for diagnostics", { path: normalizedPath });
        
        let handler: (data: any) => void;
        let debounceTimer: NodeJS.Timeout | undefined;

        return await withTimeout(
          new Promise<void>((resolve) => {
            handler = (data: any) => {
                if (data.path === normalizedPath && data.serverID === result.serverID) {
                    if (debounceTimer) clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(() => {
                        log.info("got diagnostics", { path: normalizedPath });
                        Bus.off(Event.Diagnostics.type, handler);
                        resolve();
                    }, DIAGNOSTICS_DEBOUNCE_MS);
                }
            };
            Bus.on(Event.Diagnostics.type, handler);
          }),
          3000,
        )
          .catch(() => {})
          .finally(() => {
            if (debounceTimer) clearTimeout(debounceTimer);
            if (handler) Bus.off(Event.Diagnostics.type, handler);
          });
      },
      async shutdown() {
        l.info("shutting down");
        connection.end();
        connection.dispose();
        input.server.process.kill();
        l.info("shutdown");
      },
    };

    l.info("initialized");

    return result;
  }
}
