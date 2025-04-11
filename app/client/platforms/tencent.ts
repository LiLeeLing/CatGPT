"use client";
import { ApiPath, TENCENT_BASE_URL } from "@/app/constant";
import { useAccessStore, useAppConfig, useChatStore } from "@/app/store";

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
import {
  getMessageTextContent,
  isVisionModel,
  getTimeoutMSByModel,
} from "@/app/utils";
import mapKeys from "lodash-es/mapKeys";
import mapValues from "lodash-es/mapValues";
import isArray from "lodash-es/isArray";
import isObject from "lodash-es/isObject";
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
  Messages: {
    Role: "system" | "user" | "assistant";
    Content: string | MultimodalContent[];
  }[];
  Stream?: boolean;
  Model: string;
  Temperature: number;
  TopP: number;
}

function capitalizeKeys(obj: any): any {
  if (isArray(obj)) {
    return obj.map(capitalizeKeys);
  } else if (isObject(obj)) {
    return mapValues(
      mapKeys(obj, (value: any, key: string) =>
        key.replace(/(^|_)(\w)/g, (m, $1, $2) => $2.toUpperCase()),
      ),
      capitalizeKeys,
    );
  } else {
    return obj;
  }
}

export class HunyuanApi implements LLMApi {
  path(): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.tencentUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      baseUrl = isApp ? TENCENT_BASE_URL : ApiPath.Tencent;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.Tencent)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl);
    return baseUrl;
  }

  extractMessage(res: any) {
    return res.Choices?.at(0)?.Message?.Content ?? "";
  }

  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  async chat(options: ChatOptions) {
    // --- 开始: 通用修改逻辑 (适配 Hunyuan) ---
    const processedMessagesIntermediate: ChatOptions["messages"] = [];
    for (const v of options.messages) {
      let processedContent: string | MultimodalContent[];
      const modelConfigForCheck = { ...useAppConfig.getState().modelConfig, ...useChatStore.getState().currentSession().mask.modelConfig, ...{ model: options.config.model } };
      const visionModel = isVisionModel(modelConfigForCheck.model); // Hunyuan 可能有 vision 模型

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
            if (visionModel && part.image_url) {
               // Hunyuan API 格式未知，暂时使用 OpenAI 格式
               tempContent.push(part);
            }
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
          // Hunyuan API 可能接受数组
          processedContent = filteredContent;
        } else {
          processedContent = getMessageTextContent(v);
        }

         if (v.role === "assistant" && typeof getMessageTextContentWithoutThinking === 'function') {
             if (typeof processedContent === 'string') {
                 processedContent = getMessageTextContentWithoutThinking({ role: v.role, content: processedContent });
             } else if (Array.isArray(processedContent)) {
                 // 数组情况下的 thinking 处理
                 processedContent.forEach(part => {
                     if (part.type === 'text' && part.text) {
                         part.text = getMessageTextContentWithoutThinking({ role: v.role, content: part.text });
                     }
                 });
                 processedContent = processedContent.filter(p => !(p.type === 'text' && !(p.text ?? "").trim()));
                 if (processedContent.length === 1 && processedContent[0].type === 'text') {
                     processedContent = processedContent[0].text ?? "";
                 } else if (processedContent.length === 0) {
                     processedContent = "";
                 }
             }
         }
      }

      const content = processedContent;
      processedMessagesIntermediate.push({ role: v.role, content });
    }
    // --- 结束: 通用修改逻辑 ---

    // --- Hunyuan 特定处理 ---
    const messages = processedMessagesIntermediate.map((v, index) => ({
      // "Messages 中 system 角色必须位于列表的最开始"
      role: index !== 0 && v.role === "system" ? "user" : v.role,
      content: v.content, // 保留处理后的 content (可能是 string 或 array)
    }));

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
      },
    };

    const requestPayload: RequestPayload = capitalizeKeys({ // 应用 capitalizeKeys
      model: modelConfig.model,
      messages, // 使用处理和调整角色后的 messages
      temperature: modelConfig.temperature,
      top_p: modelConfig.top_p,
      stream: options.config.stream,
    });

    console.log("[Request] Tencent payload: ", requestPayload);

    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const chatPath = this.path();
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
            console.log(
              "[Tencent] request response content type: ",
              contentType,
            );
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
              const choices = json.Choices as Array<{
                Delta: { Content: string };
              }>;
              const delta = choices[0]?.Delta?.Content;
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
        const message = this.extractMessage(resJson);
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
