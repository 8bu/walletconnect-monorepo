import pino, { Logger } from "pino";
import { generateChildLogger } from "@pedrouid/pino-utils";
import {
  JsonRpcResponse,
  isJsonRpcError,
  JsonRpcPayload,
  formatJsonRpcRequest,
  JsonRpcResult,
  isJsonRpcResult,
} from "@json-rpc-tools/utils";
import { HttpConnection } from "@json-rpc-tools/provider";
import { arrayToHex } from "enc-utils";
import { JsonRpcService } from "./jsonrpc";

import config from "./config";
import { WakuMessageResponse, WakuMessage, WakuPeers, PagingOptions } from "./types";

interface ListenCallback {
  (messages: WakuMessage[]): void;
}

export class WakuService extends HttpConnection {
  public context = "waku";
  public topics: string[] = [];
  public logger: Logger;
  public jsonrpc: JsonRpcService;
  public namespace = config.wcTopic;

  constructor(logger: Logger, jsonrpc: JsonRpcService, nodeUrl: string) {
    super(nodeUrl);
    this.jsonrpc = jsonrpc;
    this.logger = generateChildLogger(logger, `${this.context}@${nodeUrl}`);
    this.initialize();
  }

  public async postMessage(payload: string, topic: string, contentTopic?: number) {
    let jsonPayload = formatJsonRpcRequest("post_waku_v2_relay_v1_message", [
      topic,
      {
        payload,
        contentTopic,
      },
    ]);
    this.logger.debug("Posting Waku Message");
    this.logger.trace({ type: "method", method: "postMessages", payload: jsonPayload });
    this.send(jsonPayload);
  }

  public getContentMessages(topic: number): Promise<WakuMessage[]> {
    let payload = formatJsonRpcRequest("get_waku_v2_filter_v1_messages", [topic]);
    this.logger.debug("Getting Content Messages");
    this.logger.trace({ type: "method", method: "getContentMessages", payload });
    this.send(payload);
    return new Promise((resolve, reject) => {
      this.once(payload.id.toString(), (response: JsonRpcResponse) => {
        if (isJsonRpcResult(response)) {
          resolve(this.parseWakuMessage(response));
        }
        if (isJsonRpcError(response)) {
          reject(response.error);
        }
      });
    });
  }

  public getMessages(topic: string): Promise<WakuMessage[]> {
    let payload = formatJsonRpcRequest("get_waku_v2_relay_v1_messages", [topic]);

    /*
    this.logger.debug("Getting Messages");
    this.logger.trace({ type: "method", method: "getMessages", payload });
    */
    this.send(payload);
    return new Promise((resolve, reject) => {
      this.once(payload.id.toString(), (response: JsonRpcResponse) => {
        if (isJsonRpcError(response)) {
          reject(response.error);
        }
        if (isJsonRpcResult(response)) {
          resolve(this.parseWakuMessage(response));
        }
      });
    });
  }

  public async contentSubscribe(contentFilters: number): Promise<void> {
    let payload = formatJsonRpcRequest("post_waku_v2_filter_v1_subscription", [
      [{ topics: [contentFilters] }],
      this.namespace,
    ]);
    this.logger.debug("Subscribing to Waku ContentTopic");
    this.logger.trace({ type: "method", method: "contentSubscribe", payload });
    this.send(payload);
    return new Promise((resolve, reject) => {
      this.once(payload.id.toString(), (response: JsonRpcResponse) => {
        if (isJsonRpcError(response)) {
          reject(response.error);
        }
        resolve();
      });
    });
  }

  public subscribe(topic: string): Promise<void> {
    let payload = formatJsonRpcRequest("post_waku_v2_relay_v1_subscriptions", [[topic]]);
    this.logger.debug("Subscribing to Waku Topic");
    this.logger.trace({ type: "method", method: "subscribe", payload });
    this.send(payload);
    return new Promise((resolve, reject) => {
      this.once(payload.id.toString(), (response: JsonRpcResponse) => {
        if (isJsonRpcError(response)) {
          reject(response.error);
        }
        resolve();
      });
    });
  }

  public unsubscribe(topic: string) {
    this.send(formatJsonRpcRequest("delete_waku_v2_relay_v1_subscriptions", [topic]));
    this.topics = this.topics.filter(t => t !== topic);
  }

  // This won't work until the contenTopic is a string:
  // https://github.com/status-im/nim-waku/issues/447
  public getStoreMessages(topic: string) {
    let pagingOptions: PagingOptions = {
      pageSize: 10,
      forward: true,
    };
    this.send(formatJsonRpcRequest("get_waku_v2_store_v1_message", [[0], [pagingOptions]]));
  }

  public async onNewTopicMessage(topic: string, cb: ListenCallback) {
    this.subscribe(topic).then(() => {
      this.topics.push(topic);
      this.events.on(topic, cb);
    });
  }

  public getPeers(): Promise<WakuPeers[]> {
    let payload = formatJsonRpcRequest("get_waku_v2_admin_v1_peers", []);
    this.send(payload);
    return new Promise((resolve, reject) => {
      this.once(payload.id.toString(), (response: JsonRpcResponse) => {
        if (isJsonRpcError(response)) {
          reject(response.error);
        }
        resolve((response as JsonRpcResult<WakuPeers[]>).result);
      });
    });
  }

  // ---------- Private ----------------------------------------------- //

  private initialize(): void {
    this.logger.trace(`Initialized`);
    this.open().catch(console.error);
    this.on("payload", (payload: JsonRpcPayload) => {
      if (isJsonRpcError(payload)) {
        this.logger.error(payload.error);
      }
      //this.logger.trace({ method: "New Response Payload", payload });
      this.events.emit(payload.id.toString(), payload);
    });
    setInterval(() => this.poll(), 10);
  }

  private parseWakuMessage(result: JsonRpcResult<WakuMessageResponse[]>): WakuMessage[] {
    let messages: WakuMessage[] = [];
    result.result.forEach(m => {
      messages.push({
        payload: arrayToHex(m.payload),
        contentTopic: m.contentTopic,
        version: m.version,
        proof: m.proof,
      });
    });
    return messages;
  }
  private poll() {
    //this.logger.trace({ method: "poll", topics: this.topics });
    this.topics.forEach(async topic => {
      try {
        let messages = await this.getMessages(topic);
        if (messages && messages.length) {
          this.logger.trace({ method: "poll", messages: messages });
          this.events.emit(topic, messages);
        }
      } catch (e) {
        throw e;
      }
    });
  }
}
