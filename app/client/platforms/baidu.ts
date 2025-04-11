"use client";
import { ApiPath, Baidu, BAIDU_BASE_URL } from "@/app/constant";
import { useAccessStore, useAppConfig, useChatStore } from "@/app/store";
import { getAccessToken } from "@/app/utils/baidu";

import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  MultimodalContent,
  SpeechOptions,
} from "../api";
import Locale from "../../locales";
import {
  EventStreamContentType,
  fetchEventSource,
} from "@fortaine/fetch-event-source";
import { prettyObject } from "@/app/utils/format";
import { getClientConfig } from "@/app/config/client";
import { getMessageTextContent, getTimeoutMSByModel } from "@/app/utils";
import { fetch } from "@/app/utils/stream";

export interface OpenAIListModelResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    root: string;
  }>;
}

interface RequestPayload {
  messages: {
    role: "system" | "user" | "assistant";
    content: string | MultimodalContent[];
  }[];
  stream?: boolean;
  model: string;
  temperature: number;
  presence_penalty: number;
  frequency_penalty: number;
  top_p: number;
  max_tokens?: number;
}

export class ErnieApi implements LLMApi {
  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.baiduUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      // do not use proxy for baidubce api
      baseUrl = isApp ? BAIDU_BASE_URL : ApiPath.Baidu;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.Baidu)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    return [baseUrl, path].join("/");
  }

  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  
  async chat(options: ChatOptions) {
    // --- 开始: 通用修改逻辑 (适配 Baidu) ---
    const processedMessagesIntermediate: ChatOptions["messages"] = [];
    for (const v of options.messages) {
      let processedContent: string | MultimodalContent[];
      const modelConfig = { ...useAppConfig.getState().modelConfig, ...useChatStore.getState().currentSession().mask.modelConfig, ...{ model: options.config.model } };
      const visionModel = isVisionModel(modelConfig.model); // Baidu 可能没有 vision 模型，但保留逻辑

      if (typeof v.content === 'string') {
        processedContent = (v.role === "assistant" && typeof getMessageTextContentWithoutThinking === 'function')
          ? getMessageTextContentWithoutThinking(v)
          : v.content;
      } else {
        const tempContent: MultimodalContent[] = [];
        let fileText = "";

        for (const part of v.content) {
          if (part.type === 'text') {
            tempContent.push(part);
          } else if (part.type === 'image_url') {
            // Baidu API 格式未知，暂时忽略图片或添加提示
            // if (visionModel) { tempContent.push(part); }
          } else if (part.type === 'file_url' && part.file_url) {
            fileText += (fileText ? "\n" : "") + `[File attached: ${part.file_url.name}]`;
          }
        }

        if (fileText) {
          const lastTextPart = tempContent.slice().reverse().find(p => p.type === 'text') as TextContent | undefined;
          if (lastTextPart) {
            lastTextPart.text = (lastTextPart.text ?? "") + "\n" + fileText;
          } else {
            tempContent.push({ type: 'text', text: fileText });
          }
        }

        const filteredContent = tempContent.filter(p => !(p.type === 'text' && !(p.text ?? "").trim()));

        if (filteredContent.every(p => p.type === 'text')) {
          processedContent = filteredContent.map(p => p.text ?? "").join("\n");
        } else if (filteredContent.length > 0) {
          // Baidu API 可能只接受字符串，如果数组包含非文本，则回退
          processedContent = filteredContent.map(p => p.text ?? "").join("\n"); // 强制转字符串
        } else {
          processedContent = getMessageTextContent(v);
        }

         if (v.role === "assistant" && typeof getMessageTextContentWithoutThinking === 'function') {
             if (typeof processedContent === 'string') {
                 processedContent = getMessageTextContentWithoutThinking({ role: v.role, content: processedContent });
             } // 数组情况已在上面处理为字符串
         }
      }

      const content = processedContent;
      processedMessagesIntermediate.push({ role: v.role, content });
    }
    // --- 结束: 通用修改逻辑 ---

    // --- Baidu 特定处理 ---
    const messages = processedMessagesIntermediate.map((v) => ({
      // "error_code": 336006, "error_msg": "the role of message with even index in the messages must be user or function",
      role: v.role === "system" ? "user" : v.role,
      // 确保 content 是字符串
      content: typeof v.content === 'string' ? v.content : getMessageTextContent(v),
    }));

    // "error_code": 336006, "error_msg": "the length of messages must be an odd number",
    if (messages.length % 2 === 0) {
      if (messages.at(0)?.role === "user") {
      }
    }

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
      },
    };

    const shouldStream = !!options.config.stream;
    const requestPayload: RequestPayload = {
      messages,
      stream: shouldStream,
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      presence_penalty: modelConfig.presence_penalty,
      frequency_penalty: modelConfig.frequency_penalty,
      top_p: modelConfig.top_p,
    };

    console.log("[Request] Baidu payload: ", requestPayload);

    const controller = new AbortController();
    options.onController?.(controller);

    try {
      let chatPath = this.path(Baidu.ChatPath(modelConfig.model));

      // getAccessToken can not run in browser, because cors error
      if (!!getClientConfig()?.isApp) {
        const accessStore = useAccessStore.getState();
        if (accessStore.useCustomConfig) {
          if (accessStore.isValidBaidu()) {
            const { access_token } = await getAccessToken(
              accessStore.baiduApiKey,
              accessStore.baiduSecretKey,
            );
            chatPath = `${chatPath}${
              chatPath.includes("?") ? "&" : "?"
            }access_token=${access_token}`;
          }
        }
      }
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        getTimeoutMSByModel(options.config.model),
      );

      if (shouldStream) {
        let responseText = "";
        let remainText = "";
        let finished = false;
        let responseRes: Response;

        // animate response to make it looks smooth
        function animateResponseText() {
          if (finished || controller.signal.aborted) {
            responseText += remainText;
            console.log("[Response Animation] finished");
            if (responseText?.length === 0) {
              options.onError?.(new Error("empty response from server"));
            }
            return;
          }

          if (remainText.length > 0) {
            const fetchCount = Math.max(1, Math.round(remainText.length / 60));
            const fetchText = remainText.slice(0, fetchCount);
            responseText += fetchText;
            remainText = remainText.slice(fetchCount);
            options.onUpdate?.(responseText, fetchText);
          }

          requestAnimationFrame(animateResponseText);
        }

        // start animaion
        animateResponseText();

        const finish = () => {
          if (!finished) {
            finished = true;
            options.onFinish(responseText + remainText, responseRes);
          }
        };

        controller.signal.onabort = finish;

        fetchEventSource(chatPath, {
          fetch: fetch as any,
          ...chatPayload,
          async onopen(res) {
            clearTimeout(requestTimeoutId);
            const contentType = res.headers.get("content-type");
            console.log("[Baidu] request response content type: ", contentType);
            responseRes = res;
            if (contentType?.startsWith("text/plain")) {
              responseText = await res.clone().text();
              return finish();
            }

            if (
              !res.ok ||
              !res.headers
                .get("content-type")
                ?.startsWith(EventStreamContentType) ||
              res.status !== 200
            ) {
              const responseTexts = [responseText];
              let extraInfo = await res.clone().text();
              try {
                const resJson = await res.clone().json();
                extraInfo = prettyObject(resJson);
              } catch {}

              if (res.status === 401) {
                responseTexts.push(Locale.Error.Unauthorized);
              }

              if (extraInfo) {
                responseTexts.push(extraInfo);
              }

              responseText = responseTexts.join("\n\n");

              return finish();
            }
          },
          onmessage(msg) {
            if (msg.data === "[DONE]" || finished) {
              return finish();
            }
            const text = msg.data;
            try {
              const json = JSON.parse(text);
              const delta = json?.result;
              if (delta) {
                remainText += delta;
              }
            } catch (e) {
              console.error("[Request] parse error", text, msg);
            }
          },
          onclose() {
            finish();
          },
          onerror(e) {
            options.onError?.(e);
            throw e;
          },
          openWhenHidden: true,
        });
      } else {
        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();
        const message = resJson?.result;
        options.onFinish(message, res);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }
  async usage() {
    return {
      used: 0,
      total: 0,
    };
  }

  async models(): Promise<LLMModel[]> {
    return [];
  }
}
export { Baidu };
