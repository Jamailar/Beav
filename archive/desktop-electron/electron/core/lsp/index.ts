import { Bus } from "../bus";
import { Log } from "../util/log";
import { LSPClient } from "./client";
import * as path from "path";
import { pathToFileURL } from "url";
import { LSPServer } from "./server";
import { Instance } from "../instance";
import { spawn } from "child_process";

export namespace LSP {
  const log = Log.create({ service: "lsp" });

  export const Event = {
    Updated: { type: "lsp.updated", properties: {} },
  };

  // State
  const servers: Record<string, LSPServer.Info> = { ...LSPServer };
  const clients: LSPClient.Info[] = [];
  const spawning = new Map<string, Promise<LSPClient.Info | undefined>>();
  const broken = new Set<string>();

  export async function getClients(file: string) {
    const extension = path.parse(file).ext || file;
    const result: LSPClient.Info[] = [];

    async function schedule(server: LSPServer.Info, root: string, key: string) {
      const handle = await server
        .spawn(root)
        .then((value) => {
          if (!value) broken.add(key);
          return value;
        })
        .catch((err) => {
          broken.add(key);
          log.error(`Failed to spawn LSP server ${server.id}`, { error: err });
          return undefined;
        });

      if (!handle) return undefined;
      log.info("spawned lsp server", { serverID: server.id });

      const client = await LSPClient.create({
        serverID: server.id,
        server: handle,
        root,
      }).catch((err) => {
        broken.add(key);
        handle.process.kill();
        log.error(`Failed to initialize LSP client ${server.id}`, { error: err });
        return undefined;
      });

      if (!client) {
        handle.process.kill();
        return undefined;
      }

      const existing = clients.find((x) => x.root === root && x.serverID === server.id);
      if (existing) {
        handle.process.kill();
        return existing;
      }

      clients.push(client);
      return client;
    }

    for (const server of Object.values(servers)) {
      // @ts-ignore
      if (server.extensions.length && !server.extensions.includes(extension)) continue;

      // @ts-ignore
      const root = await server.root(file);
      if (!root) continue;
      if (broken.has(root + server.id)) continue;

      const match = clients.find((x) => x.root === root && x.serverID === server.id);
      if (match) {
        result.push(match);
        continue;
      }

      const inflight = spawning.get(root + server.id);
      if (inflight) {
        const client = await inflight;
        if (!client) continue;
        result.push(client);
        continue;
      }

      const task = schedule(server, root, root + server.id);
      spawning.set(root + server.id, task);

      task.finally(() => {
        if (spawning.get(root + server.id) === task) {
          spawning.delete(root + server.id);
        }
      });

      const client = await task;
      if (!client) continue;

      result.push(client);
      Bus.emit(Event.Updated.type, {});
    }

    return result;
  }

  export async function hasClients(file: string) {
    const extension = path.parse(file).ext || file;
    for (const server of Object.values(servers)) {
      // @ts-ignore
      if (server.extensions.length && !server.extensions.includes(extension)) continue;
      // @ts-ignore
      const root = await server.root(file);
      if (!root) continue;
      if (broken.has(root + server.id)) continue;
      return true;
    }
    return false;
  }

  export async function touchFile(input: string, waitForDiagnostics?: boolean) {
    log.info("touching file", { file: input });
    const clients = await getClients(input);
    await Promise.all(
      clients.map(async (client) => {
        const wait = waitForDiagnostics ? client.waitForDiagnostics({ path: input }) : Promise.resolve();
        await client.notify.open({ path: input });
        return wait;
      }),
    ).catch((err) => {
      log.error("failed to touch file", { err, file: input });
    });
  }

  // --- Operations ---

  async function run<T>(file: string, input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
    const clients = await getClients(file);
    const tasks = clients.map((x) => input(x));
    return Promise.all(tasks);
  }

  async function runAll<T>(input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
      const tasks = clients.map(x => input(x));
      return Promise.all(tasks);
  }

  export async function definition(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/definition", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => null),
    ).then((result) => result.flat().filter(Boolean));
  }

  export async function references(input: { file: string; line: number; character: number }) {
    return run(input.file, (client) =>
      client.connection
        .sendRequest("textDocument/references", {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
          context: { includeDeclaration: true },
        })
        .catch(() => []),
    ).then((result) => result.flat().filter(Boolean));
  }

  export async function hover(input: { file: string; line: number; character: number }) {
      return run(input.file, (client) => 
        client.connection
          .sendRequest("textDocument/hover", {
            textDocument: {
              uri: pathToFileURL(input.file).href,
            },
            position: {
              line: input.line,
              character: input.character,
            },
          })
          .catch(() => null)
      );
  }

  export async function documentSymbol(uri: string) {
    const file = new URL(uri).pathname;
    return run(file, (client) =>
      client.connection
        .sendRequest("textDocument/documentSymbol", {
          textDocument: {
            uri,
          },
        })
        .catch(() => []),
    )
      .then((result) => result.flat())
      .then((result) => result.filter(Boolean));
  }

  export async function workspaceSymbol(query: string) {
      return runAll((client) => 
        client.connection.sendRequest("workspace/symbol", { query })
        .then((result: any) => result) // Simplified
        .catch(() => [])
      ).then(result => result.flat());
  }

  export async function implementation(input: { file: string; line: number; character: number }) {
      return run(input.file, client => 
        client.connection.sendRequest("textDocument/implementation", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character }
        }).catch(() => null)
      ).then(result => result.flat().filter(Boolean));
  }

  export async function prepareCallHierarchy(input: { file: string; line: number; character: number }) {
      return run(input.file, client => 
        client.connection.sendRequest("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character }
        }).catch(() => [])
      ).then(result => result.flat().filter(Boolean));
  }
    
  export async function incomingCalls(input: { file: string; line: number; character: number }) {
      return run(input.file, async (client) => {
          const items = (await client.connection
            .sendRequest("textDocument/prepareCallHierarchy", {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            })
            .catch(() => [])) as any[];
          if (!items?.length) return [];
          return client.connection.sendRequest("callHierarchy/incomingCalls", { item: items[0] }).catch(() => []);
      }).then((result) => result.flat().filter(Boolean));
  }

  export async function outgoingCalls(input: { file: string; line: number; character: number }) {
      return run(input.file, async (client) => {
          const items = (await client.connection
            .sendRequest("textDocument/prepareCallHierarchy", {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            })
            .catch(() => [])) as any[];
          if (!items?.length) return [];
          return client.connection.sendRequest("callHierarchy/outgoingCalls", { item: items[0] }).catch(() => []);
      }).then((result) => result.flat().filter(Boolean));
  }

}
