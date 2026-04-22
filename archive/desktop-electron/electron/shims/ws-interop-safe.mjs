import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wsModule = require('ws');

const WebSocket = wsModule.WebSocket || wsModule;
const WebSocketServer = wsModule.WebSocketServer;
const Receiver = wsModule.Receiver;
const Sender = wsModule.Sender;
const createWebSocketStream = wsModule.createWebSocketStream;

// Default export keeps compatibility for `import * as NodeWs from "ws"` callers.
const safeNamespace = Object.freeze({
  WebSocket,
  WebSocketServer,
  Receiver,
  Sender,
  createWebSocketStream,
  default: wsModule,
});

export {
  WebSocket,
  WebSocketServer,
  Receiver,
  Sender,
  createWebSocketStream,
};

export default safeNamespace;
