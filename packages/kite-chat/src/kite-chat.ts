import type {
  JoinOptions,
  KiteMsg,
  ContentMsg,
} from './kite-types';

import {MsgType} from './kite-types';

import {
  KiteChatElement,
  KiteMsgElement,
  KiteFileElement,
  KiteMsg as KiteChatMsg,
  randomStringId,
  isPlaintextMsg,
  MsgStatus,
  isFileMsg,
  NotificationType,
  KiteMsgDelete,
} from '@pragmasoft-ukraine/kite-chat-component';

import {assert} from './assert';
import {
  KiteDB, 
  openDatabase, 
  getMessages, 
  addMessage,
  modifyMessage,
  deleteMessage,
  messageById
} from './kite-storage';
import {KiteWebsocket} from './kite-websocket';
import {CHANNEL_NAME} from './shared-constants';

export type KiteChatOptions = {
  endpoint: string;
  eagerlyConnect?: boolean;
  createIfMissing?: boolean;
  open?: boolean;
  userId?: string;
  userName?: string;
};

const DEFAULT_OPTS: Partial<KiteChatOptions> = {
  eagerlyConnect: false,
  createIfMissing: true,
  open: false,
};

const KITE_USER_ID_STORE_KEY = 'KITE_USER_ID';
const KITE_RECONNECT_TIMEOUT = 1000;

export class KiteChat {
  protected readonly opts: KiteChatOptions;
  protected kiteWebsocket: KiteWebsocket | null;
  protected kiteChannel: BroadcastChannel;
  readonly element: KiteChatElement | null;
  private db: KiteDB | null;
  public notificationTitle: string;
  public notificationOptions: NotificationOptions;
  private connectionTimeout: ReturnType<typeof setInterval> | null = null;

  constructor(opts: KiteChatOptions) {
    this.opts = Object.assign({}, DEFAULT_OPTS, opts);
    if (!this.opts.userId) {
      this.opts.userId = this.persistentRandomId();
    }
    console.debug('new KiteChat', JSON.stringify(this.opts));
    console.debug('origin', location.origin);
    console.debug('meta.url.origin', new URL(import.meta.url).origin);

    this.element = this.findOrCreateElement(
      this.opts.createIfMissing as boolean
    );

    this.notificationTitle = this.element?.heading || '';
    this.notificationOptions = {
      icon: this.getFaviconURL(),
    };

    openDatabase().then((db: KiteDB) => {
      this.db = db;
      this.restore();
    }).catch((e: Error) => {
      console.error("Failed to open indexedDB:", e.message);
    })

    const kiteChannel = new BroadcastChannel(CHANNEL_NAME);
    kiteChannel.onmessage = this.onChannelMessage.bind(this);

    this.kiteChannel = kiteChannel;

    this.initClient();

    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.initClient();
        this.restore();
      }
    });

    addEventListener('click', this.handleUserInteraction.bind(this));
  }

  private handleUserInteraction() {
    removeEventListener('click', this.handleUserInteraction.bind(this));
  
    Notification.requestPermission();
  }
  
  private initClient() {
    this.kiteChannel.postMessage({type: MsgType.JOIN});

    this.connectionTimeout = setTimeout(() => {
      this.kiteChannel.postMessage({type: MsgType.CONNECTED});
      setTimeout(() => {!this.kiteWebsocket && this.connect();});
    }, KITE_RECONNECT_TIMEOUT);
  }

  public connect() {
    console.debug('connect');

    const kiteWebsocket = new KiteWebsocket();

    const endpoint = new URL(this.opts.endpoint);

    assert(
      endpoint.protocol.toLocaleLowerCase().startsWith('ws'),
      'ws and wss protocols are only supported for the endpoint url'
    );
    assert(
      endpoint.searchParams.has('c'),
      'enpoint url should have c=<channel name> required query parameter'
    );

    const options: JoinOptions = {
      endpoint: this.opts.endpoint,
      memberId: this.opts.userId as string,
      memberName: this.opts.userName,
      eagerlyConnect: this.opts.eagerlyConnect,
    };

    kiteWebsocket.onContentMessage = this.onContentMessage.bind(this);
    kiteWebsocket.onMessageAck = this.onMessageAck.bind(this);
    kiteWebsocket.onFailedMessage = this.onFailedMessage.bind(this);
    kiteWebsocket.onError = this.onError.bind(this);
    kiteWebsocket.onZippedMessage = this.onZippedMessage.bind(this);
    kiteWebsocket.onOnline = () => {this.log('Online', NotificationType.SUCCESS)};
    kiteWebsocket.onOffline = () => {this.log('Offline', NotificationType.WARNING)};
    kiteWebsocket.join(options);

    this.kiteWebsocket = kiteWebsocket;
  }

  public disconnect() {
    console.debug('disconnect');
    this.kiteWebsocket?.disconnect();
    this.kiteWebsocket = null;
  }

  private onChannelMessage(e: MessageEvent<KiteMsg>) {
    const data = e.data;

    switch(data.type) {
      case MsgType.CONNECTED:
        this.disconnect();
        break;
      case MsgType.JOIN:
        this.connectionTimeout && clearTimeout(this.connectionTimeout);
    }
  }

  private create(msg: ContentMsg) {
    this.element?.appendMsg(msg);

    if(!this.db) return;
    addMessage(msg, this.db);
  }

  private update(messageId: string, updatedMsg: ContentMsg) {
    this.element?.editMsg(messageId, updatedMsg);

    if(!this.db) return;
    messageById(messageId, this.db).then(originalMessage => {
      if(!this.db || !originalMessage) return;
      modifyMessage(messageId, {...originalMessage, ...updatedMsg}, this.db);
    });
  }

  private delete(messageId: string) {
    const msgElement = document.querySelector(
      `${KiteMsgElement.TAG}[messageId="${messageId}"]`
    ) as KiteFileElement | undefined;
    msgElement?.remove();

    if(!this.db) return;

    deleteMessage(messageId, this.db);
  }

  private restore() {
    if(!this.db) return;
    const msgElements = document.querySelectorAll(
      `${KiteMsgElement.TAG}`
    )
    const lastElement = msgElements.length > 0 
      ? (msgElements[msgElements.length - 1] as KiteMsgElement).messageId 
      : undefined;
    getMessages(this.db, lastElement).then((messages: ContentMsg[]) => {
      console.debug("getMessages", messages);
      for (const msg of messages) {
        this.element?.appendMsg(msg, false);
      }
    }).catch((e: Error) => {
      console.error("Failed to get messages from storage:", e.message);
      this.element?.appendNotification({message: 'Failed to restore messages', type: NotificationType.ERROR});
    });
  }

  protected persistentRandomId(): string {
    let savedId = localStorage.getItem(KITE_USER_ID_STORE_KEY);
    if (!savedId) {
      savedId = randomStringId();
      localStorage.setItem(KITE_USER_ID_STORE_KEY, savedId);
    }
    return savedId;
  }

  private send(outgoing: ContentMsg) {
    if (isPlaintextMsg(outgoing)) {
      this.kiteWebsocket?.sendPlaintextMessage(outgoing);
    } else if (isFileMsg(outgoing)) {
      this.kiteWebsocket?.sendFileMessage(outgoing);
    } else {
      throw new Error('Unexpected payload type ' + JSON.stringify(outgoing));
    }
  }

  protected onOutgoingMessage(msg: CustomEvent<KiteChatMsg>) {
    const outgoing = msg.detail as ContentMsg;
    console.debug('outgoing', outgoing);

    if(!this.db) {
      return;
    }
    if(!outgoing.edited) {
      addMessage(outgoing, this.db).then(() => {
        this.send(outgoing);
      });
    } else {
      modifyMessage(outgoing.messageId, outgoing, this.db).then(() => {
        this.send(outgoing);
      });
    }
    //TODO backend message editing
  }

  protected onDeleteMessage(msg: CustomEvent<KiteMsgDelete>) {
    const {detail} = msg;
    console.debug('onDeleteMessage', detail);
    this.delete(detail.messageId);
    //TODO backend message deleting
  }

  protected onElementShow() {
    console.debug('onElementShow');
  }

  protected findOrCreateElement(createIfMissing: boolean) {
    let element = document.querySelector('kite-chat');
    if (!element) {
      if (!createIfMissing) {
        return null;
      }
      element = new KiteChatElement();
      this.opts.open ? element.show() : element.hide();
      document.body.appendChild(element);
    }
    element.addEventListener(
      'kite-chat.send',
      this.onOutgoingMessage.bind(this)
    );
    element.addEventListener(
      'kite-chat.delete',
      this.onDeleteMessage.bind(this)
    );
    element.addEventListener('kite-chat.show', this.onElementShow.bind(this));
    return element;
  }

  protected onContentMessage(incoming: ContentMsg) {
    console.debug('onContentMessage', incoming.messageId, incoming.timestamp);

    if(!incoming.edited) {
      this.create(incoming);
    } else {
      this.update(incoming.messageId, incoming);
    }

    this.msgNotification(incoming);
  }

  protected msgNotification(msg: ContentMsg) {
    // Use the Notification API to show a system notification
    if (Notification.permission === 'granted') {  
      const notification = new Notification(this.notificationTitle, {
        ...this.notificationOptions,
        image: isPlaintextMsg(msg) ? undefined : URL.createObjectURL(msg.file),
      });
      notification.onclick = this.onNotificationClick.bind(this);
    }
  }

  protected onNotificationClick() {
    this.element?.show();
  }

  protected getFaviconURL(): string | undefined {
    const faviconElement = document.querySelector("link[rel='icon']") || document.querySelector("link[rel='shortcut icon']");
    return faviconElement ? (faviconElement as HTMLLinkElement).href : undefined;
  }

  protected onMessageAck(messageId: string, destiationMessageId: string, timestamp: Date) {
    console.debug('onMessageAck', messageId, timestamp);
    this.update(messageId, {messageId: destiationMessageId, status: MsgStatus.delivered} as ContentMsg);
  }

  protected onError(reason: string, code: number) {
    // TODO display error as a text message
    console.error(code, reason);
    const errorMessage = reason || 'Unknown error.';
    this.element?.appendNotification({message: errorMessage, type: NotificationType.ERROR});
  }

  protected onZippedMessage(messageId: string, zippedIds: string[], file: File) {
    console.debug('onZippedMessage', messageId, zippedIds);
    this.update(messageId, {file} as ContentMsg);
    zippedIds.forEach(id => this.delete(id));
  }

  protected onFailedMessage(messageId: string, reason: string, description?: string) {
    console.debug('onFailedMessage', messageId, reason);
    const errorMessage = description || 'Unknown error.';
    this.element?.appendNotification({message: errorMessage, type: NotificationType.ERROR});
    this.update(messageId, {status: MsgStatus.failed} as ContentMsg);
  }

  protected onDeliveryError(msg: MessageEvent<unknown>) {
    // TODO retry?
    // TODO mark message with a failed status
    console.error('Cannot deliver message ', msg);
  }

  /**
   * @param msg
   */
  protected log(message: string, type: NotificationType = NotificationType.INFO) {
    this.element?.appendNotification({message, type, duration: 'auto'});
  }
}
