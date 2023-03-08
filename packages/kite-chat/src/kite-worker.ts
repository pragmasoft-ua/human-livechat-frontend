// https://joshuatz.com/posts/2021/strongly-typed-service-workers/
/// <reference lib="webworker" />

const WS_CLOSE_REASON_GONE_AWAY = 1001;

// const READY_STATES = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];

declare const self: SharedWorkerGlobalScope;

import {MessagePort} from 'worker_threads';
import type {
  ContentMsg,
  ErrorResponse,
  FileMsg,
  JoinChannel,
  KiteMsg,
  MsgAck,
  PlaintextMsg,
  BinMsg,
  Upload,
} from './kite-types';
import {MsgType, MsgStatus} from './kite-types';
import {decodeKiteMsg, encodeKiteMsg} from './serialization';
import {SUBPROTOCOL} from './shared-constants';

const WORKER_NAME = 'kite worker';

/**
 * @deprecated this is a workaround for a missing method Array.findLast()
 * https://github.com/microsoft/TypeScript/issues/48829
 */
interface KiteArray<T> extends Array<T> {
  findLast(
    predicate: (value: T, index: number, obj: T[]) => unknown,
    thisArg?: unknown
  ): T | undefined;
}

interface KiteMessagePort extends MessagePort {
  postMessage(value: KiteMsg): void;
}

/*
 * ws is null initially and until the first connection, which is delayed till the first
 * outgoing message is sent, unless eagerlyConnect option is set in a JoinChannel message.
 *
 * Then, it is automatically reconnected forever on the connection loss, so ws shouldn't be null
 * once connected, but ws.readyState may be not ws.OPEN
 *
 * ws can be reset back to null if network is offline or if all tabs are closed (tabsCount === 0)
 * but in this case shared worker is anyway destroyed.
 */
let ws: WebSocket | null;

/**
 * Cache JoinChannel request till the time we will send it to the server after
 * ws connection is established.
 */
let joinChannel: JoinChannel | null = null;

/**
 * Keeps ordered list of all messages (incoming and outgoing) to populate new browser tabs
 * when those connected
 */
const messageHistory = new Array<ContentMsg>() as KiteArray<ContentMsg>;
const outgoingQueue = new Array<KiteMsg>();

const tabPorts = new Set<KiteMessagePort>();

const broadcast = (msg: KiteMsg, exclude?: KiteMessagePort) => {
  for (const tabPort of tabPorts) {
    if (tabPort !== exclude) {
      tabPort.postMessage(msg);
    }
  }
};

// keep track of online status.
let online = self.navigator.onLine;
console.log(WORKER_NAME, 'created', online ? 'online' : 'offline');

const MIN_RECONNECTION_INTERVAL_MS = 1000 * 60; // 60s

/**
 * Track the time when last ws connection was establisted to ensure
 * minimal reconnection interval (to avoid reconnecting too often infinitely)
 */
let connectedTimestampMs = 0;
let reconnectionAttempts = 0;

// Event handler called when a tab tries to connect to this worker.
self.onconnect = onTabConnected;
self.onoffline = onOffline;
self.ononline = onOnline;

function onTabConnected(e: MessageEvent) {
  const port = e.ports[0];
  port.onmessage = onTabMessage;
  port.onmessageerror = console.error;
  tabPorts.add(port as unknown as KiteMessagePort);
  console.debug(WORKER_NAME, 'tab connected', tabPorts.size);
  port.postMessage({
    type: MsgType.CONNECTED,
    messageHistory,
  });
}

function onTabMessage(e: MessageEvent<KiteMsg>) {
  const tabPort = e.target as unknown as KiteMessagePort;
  const payload = e.data;
  assert(!!payload, 'Missing payload');
  console.debug(WORKER_NAME, 'tab message', JSON.stringify(payload));
  switch (payload.type) {
    case MsgType.JOIN:
      onJoinChannel(payload);
      break;
    case MsgType.PLAINTEXT:
      onPlaintextMessage(payload, tabPort);
      break;
    case MsgType.FILE:
      onFileMessage(payload, tabPort);
      break;
    case MsgType.DISCONNECTED:
      onTabDisconnected(tabPort);
      break;
  }
}

function onOnline() {
  console.log(WORKER_NAME, 'went online');
  online = true;
  if (tabPorts.size === 0) {
    console.log(WORKER_NAME, 'no tabs open');
    return;
  }
  if (outgoingQueue.length > 0) {
    console.log(
      WORKER_NAME,
      'outgoing queue has messages, trigger ws reconnection'
    );
    triggerWsConnection();
  } else if (joinChannel?.eagerlyConnect) {
    console.log(WORKER_NAME, 'eagerlyConnect is true, trigger ws reconnection');
    triggerWsConnection();
  }
}

function onOffline() {
  console.log(WORKER_NAME, 'went offline');
  online = false;
  if (ws?.readyState === ws?.OPEN) {
    console.warn('unexpected state, ws is open while offline, closing it');
    ws?.close();
  }
  ws = null;
}

function onPlaintextMessage(payload: PlaintextMsg, tabPort: KiteMessagePort) {
  messageHistory.push(payload);
  outgoingQueue.push(payload);
  broadcast(payload, tabPort);
  if (ws) {
    ws.readyState === ws.OPEN && flushQueue();
  } else if (online) {
    triggerWsConnection();
  }
}

function onFileMessage(payload: FileMsg, tabPort: KiteMessagePort) {
  messageHistory.push(payload);
  broadcast(payload, tabPort);
  const upload: Upload = {
    type: MsgType.UPLOAD,
    messageId: payload.messageId,
    fileName: payload.file.name,
    fileType: payload.file.type,
    fileSize: payload.file.size,
  };
  outgoingQueue.push(upload);
  if (ws) {
    ws.readyState === ws.OPEN && flushQueue();
  } else if (online) {
    triggerWsConnection();
  }
}

function onJoinChannel(payload: JoinChannel) {
  joinChannel = joinChannel || payload;
  joinChannel.eagerlyConnect =
    joinChannel.eagerlyConnect || payload.eagerlyConnect;
  assert(
    joinChannel.endpoint === payload.endpoint,
    'Cannot use different chat endpoints for the same domain'
  );
  if (!ws && joinChannel.eagerlyConnect) {
    triggerWsConnection();
  }
}

/**
 * @param payload
 * @param port
 */
function onTabDisconnected(port: KiteMessagePort) {
  port.close();
  tabPorts.delete(port);
  const tabsCount = tabPorts.size;
  console.debug(WORKER_NAME, `onTabDisconnected remained ${tabsCount} tabs`);
  if (tabsCount === 0) {
    // https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4
    ws?.close(WS_CLOSE_REASON_GONE_AWAY, 'all active tabs closed');
  }
}

function triggerWsConnection() {
  console.log(WORKER_NAME, 'ws connecting..', reconnectionAttempts++);
  assert(!!joinChannel, 'Missing websocket connection configuration');
  const endpoint = joinChannel.endpoint;
  ws = new WebSocket(endpoint, SUBPROTOCOL);
  ws.onmessage = onWsMessage;
  ws.onopen = onWsOpen;
  ws.onclose = onWsClose;
  ws.onerror = onWsError;
}

function onWsMessage(event: MessageEvent) {
  const payload = event.data;
  console.log(WORKER_NAME, 'ws received', payload);
  const kiteMsg = decodeKiteMsg(payload);
  switch (kiteMsg.type) {
    case MsgType.PLAINTEXT:
      onWsPlaintextMessage(payload as PlaintextMsg);
      break;
    case MsgType.BIN:
      onWsFileMessage(payload as BinMsg);
      break;
    case MsgType.ACK:
      onMessageAck(payload as MsgAck);
      break;
    case MsgType.ERROR:
      onErrorResponse(payload as ErrorResponse);
      break;
  }
}

function onWsOpen() {
  console.debug(WORKER_NAME, 'ws connected');
  connectedTimestampMs = Date.now();
  assert(!!joinChannel, 'no pending joinChannel message');
  send(joinChannel);
  flushQueue();
  broadcast({type: MsgType.ONLINE});
}

function onWsClose(e: CloseEvent) {
  const sessionDurationMs = connectedTimestampMs
    ? Date.now() - connectedTimestampMs
    : 0;
  console.debug(
    WORKER_NAME,
    `ws disconnected, session duration ${Math.round(
      (sessionDurationMs * 60) / 1000
    )} minutes`,
    e
  );
  broadcast({type: MsgType.OFFLINE, sessionDurationMs});
  if (!online) {
    console.warn(WORKER_NAME, 'offline, do not reconnect');
    ws = null;
    return;
  }
  if (tabPorts.size === 0) {
    console.warn(WORKER_NAME, 'no open tabs, do not reconnect');
    ws = null;
    return;
  }
  const timeToReconnect = MIN_RECONNECTION_INTERVAL_MS - sessionDurationMs;
  if (timeToReconnect > 0) {
    console.debug(WORKER_NAME, 'schedule reconnect', timeToReconnect);
    setTimeout(triggerWsConnection, timeToReconnect);
  } else {
    triggerWsConnection();
  }
}

function onWsError(e: Event) {
  console.debug(WORKER_NAME, 'onWsError', e);
  // TODO close ws in the case of error?
}

function onWsPlaintextMessage(payload: PlaintextMsg) {
  messageHistory.push(payload);
  broadcast(payload);
}

async function onWsFileMessage(payload: BinMsg) {
  // TODO try/catch
  const file: File = await downloadUrl(payload.url);
  const incoming: FileMsg = {
    ...payload,
    type: MsgType.FILE,
    file,
  };
  messageHistory.push(incoming);
  broadcast(incoming);
}

async function downloadUrl(url: string): Promise<File> {
  // TODO implement
  throw new Error('Not implemented downloading of ' + url);
}

function onMessageAck(payload: MsgAck) {
  const msg = messageHistory.findLast(
    (msg) => msg.messageId === payload.messageId
  );
  if (msg) {
    msg.messageId = payload.destiationMessageId;
    msg.status = MsgStatus.delivered;
  } else {
    console.warn(WORKER_NAME, 'Unexpected Ack', payload.messageId);
  }
  // TODO handle properly in tab controller
  broadcast(payload);
}

function onErrorResponse(payload: ErrorResponse) {
  // TODO add error message to the messageHistory
  console.error(WORKER_NAME, payload.code, payload.reason);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function send(payload: KiteMsg) {
  assert(!!ws, 'No Websocket connection');
  assert(ws.readyState === ws.OPEN, 'Websocket is not ready');
  console.debug(WORKER_NAME, 'ws send', payload);
  const encoded = encodeKiteMsg(payload);
  ws.send(encoded);
}

function flushQueue() {
  let queueSize = outgoingQueue.length;
  if (queueSize <= 0) return;
  console.debug(WORKER_NAME, 'flush queue', queueSize);
  while (queueSize-- > 0) {
    const payload = outgoingQueue[0];
    send(payload);
    outgoingQueue.shift();
  }
}
