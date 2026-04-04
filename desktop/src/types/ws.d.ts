declare module 'ws' {
  import type { EventEmitter } from 'events';
  import type * as http from 'node:http';
  import type { Duplex } from 'node:stream';

  export class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
  }

  export type VerifyClientInfo = {
    origin: string;
    secure: boolean;
    req: http.IncomingMessage;
  };

  export type VerifyClientCallbackSync = (info: VerifyClientInfo) => boolean;

  export type WebSocketServerOptions = {
    noServer?: boolean;
    host?: string;
    port?: number;
    path?: string;
    verifyClient?: VerifyClientCallbackSync;
  };

  export class WebSocketServer extends EventEmitter {
    constructor(options?: WebSocketServerOptions);
    handleUpgrade(
      request: http.IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (client: WebSocket, request: http.IncomingMessage) => void,
    ): void;
    close(callback?: () => void): void;
  }
}
