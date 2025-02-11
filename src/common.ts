import { PartialMessage } from '@bufbuild/protobuf';
import { Code, ConnectError, PromiseClient, createPromiseClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { v4 as uuidv4 } from 'uuid';

import { Metadata } from '../proto/exa/codeium_common_pb/codeium_common_pb';
import { LanguageServerService } from '../proto/exa/language_server_pb/language_server_connect';
import {
  AcceptCompletionRequest,
  GetCompletionsRequest,
  GetCompletionsResponse,
} from '../proto/exa/language_server_pb/language_server_pb';

const EXTENSION_NAME = 'chrome';
const EXTENSION_VERSION = '1.6.13';

export const CODEIUM_DEBUG = false;

export interface ClientSettings {
  apiKey?: string;
  defaultModel?: string;
}

async function getClientSettings(extensionId: string): Promise<ClientSettings> {
  return await new Promise<ClientSettings>((resolve) => {
    chrome.runtime.sendMessage(
      extensionId,
      { type: 'clientSettings' },
      (response: ClientSettings) => {
        resolve(response);
      }
    );
  });
}

function languageServerClient(baseUrl: string): PromiseClient<typeof LanguageServerService> {
  const transport = createConnectTransport({
    baseUrl,
    useBinaryFormat: true,
  });
  return createPromiseClient(LanguageServerService, transport);
}

class ClientSettingsPoller {
  // This is initialized to a promise at construction, then updated to a
  // non-promise later.
  clientSettings: Promise<ClientSettings> | ClientSettings;
  constructor(extensionId: string) {
    this.clientSettings = getClientSettings(extensionId);
    setInterval(async () => {
      this.clientSettings = await getClientSettings(extensionId);
    }, 500);
  }
}

export interface IdeInfo {
  ideName: string;
  ideVersion: string;
}

export class LanguageServerServiceWorkerClient {
  // Note that the URL won't refresh post-initialization.
  client: Promise<PromiseClient<typeof LanguageServerService> | undefined>;
  private abortController?: AbortController;

  constructor(baseUrlPromise: Promise<string | undefined>, private readonly sessionId: string) {
    this.client = (async (): Promise<PromiseClient<typeof LanguageServerService> | undefined> => {
      const baseUrl = await baseUrlPromise;
      if (baseUrl === undefined) {
        return undefined;
      }
      return languageServerClient(baseUrl);
    })();
  }

  getHeaders(apiKey: string | undefined): Record<string, string> {
    if (apiKey === undefined) {
      return {};
    }
    const Authorization = `Basic ${apiKey}-${this.sessionId}`;
    return { Authorization };
  }

  async getCompletions(
    request: GetCompletionsRequest
  ): Promise<GetCompletionsResponse | undefined> {
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const getCompletionsPromise = (await this.client)?.getCompletions(request, {
      signal,
      headers: this.getHeaders(request.metadata?.apiKey),
    });
    try {
      return await getCompletionsPromise;
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      if (err instanceof ConnectError) {
        if (err.code != Code.Canceled) {
          console.log(err.message);
          void chrome.runtime.sendMessage(chrome.runtime.id, {
            type: 'error',
            message: err.message,
          });
        }
      } else {
        console.log((err as Error).message);
        void chrome.runtime.sendMessage(chrome.runtime.id, {
          type: 'error',
          message: (err as Error).message,
        });
      }
      return;
    }
  }

  async acceptedLastCompletion(
    acceptCompletionRequest: PartialMessage<AcceptCompletionRequest>
  ): Promise<void> {
    try {
      await (
        await this.client
      )?.acceptCompletion(acceptCompletionRequest, {
        headers: this.getHeaders(acceptCompletionRequest.metadata?.apiKey),
      });
    } catch (err) {
      console.log((err as Error).message);
    }
  }
}

interface GetCompletionsRequestMessage {
  kind: 'getCompletions';
  requestId: number;
  request: string;
}

interface AcceptCompletionRequestMessage {
  kind: 'acceptCompletion';
  request: string;
}

export type LanguageServerWorkerRequest =
  | GetCompletionsRequestMessage
  | AcceptCompletionRequestMessage;

export interface GetCompletionsResponseMessage {
  kind: 'getCompletions';
  requestId: number;
  response?: string;
}

export type LanguageServerWorkerResponse = GetCompletionsResponseMessage;

export class LanguageServerClient {
  private sessionId = uuidv4();
  private port: chrome.runtime.Port;
  private requestId = 0;
  private promiseMap = new Map<number, (res: GetCompletionsResponse | undefined) => void>();
  clientSettingsPoller: ClientSettingsPoller;

  constructor(readonly extensionId: string) {
    this.port = this.createPort();
    this.clientSettingsPoller = new ClientSettingsPoller(extensionId);
  }

  createPort(): chrome.runtime.Port {
    const port = chrome.runtime.connect(this.extensionId, { name: this.sessionId });
    port.onDisconnect.addListener(() => {
      this.port = this.createPort();
    });
    port.onMessage.addListener(async (message: LanguageServerWorkerResponse) => {
      if (message.kind === 'getCompletions') {
        let res: GetCompletionsResponse | undefined = undefined;
        if (message.response !== undefined) {
          res = GetCompletionsResponse.fromJsonString(message.response);
        }
        this.promiseMap.get(message.requestId)?.(res);
        this.promiseMap.delete(message.requestId);
      }
    });
    return port;
  }

  getMetadata(ideInfo: IdeInfo, apiKey: string): Metadata {
    return new Metadata({
      ideName: ideInfo.ideName,
      ideVersion: ideInfo.ideVersion,
      extensionName: EXTENSION_NAME,
      extensionVersion: EXTENSION_VERSION,
      apiKey,
      locale: navigator.language,
      sessionId: this.sessionId,
      requestId: BigInt(++this.requestId),
      userAgent: navigator.userAgent,
      url: window.location.href,
    });
  }

  async getCompletions(
    request: GetCompletionsRequest
  ): Promise<GetCompletionsResponse | undefined> {
    const requestId = Number(request.metadata?.requestId);
    const prom = new Promise<GetCompletionsResponse | undefined>((resolve) => {
      this.promiseMap.set(requestId, resolve);
    });
    const message: GetCompletionsRequestMessage = {
      kind: 'getCompletions',
      requestId,
      request: request.toJsonString(),
    };
    this.port.postMessage(message);
    return prom;
  }

  acceptedLastCompletion(ideInfo: IdeInfo, apiKey: string, completionId: string): void {
    const request = new AcceptCompletionRequest({
      metadata: this.getMetadata(ideInfo, apiKey),
      completionId,
    });
    const message: AcceptCompletionRequestMessage = {
      kind: 'acceptCompletion',
      request: request.toJsonString(),
    };
    this.port.postMessage(message);
  }
}
