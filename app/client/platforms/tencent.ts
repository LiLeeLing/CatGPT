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
import { preProcessMultimodalContent } from "@/app/utils/chat"; // 引入预处理函数
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
      const visionModel = isVisionModel(options.config.model);

      // 预处理消息内容，然后格式化为 API 期望的格式
      const messages = await Promise.all(options.messages.map(async (v, index) => {
          // "Messages 中 system 角色必须位于列表的最开始"
          const role = index !== 0 && v.role === "system" ? "user" : v.role;
          let content: string | MultimodalContent[]; // API 期望的格式

          // 预处理获取 Base64 (如果需要)
          // 注意：预处理现在应该在外部 (store/chat.ts) 完成，这里理论上不需要再次调用
          // 但为了确保拿到 Base64，我们暂时保留调用
          const processedContent = await preProcessMultimodalContent(v.content);

          if (typeof processedContent === 'string' || !visionModel) {
              // 如果是字符串或非视觉模型，获取纯文本
              content = typeof processedContent === 'string' ? processedContent : getMessageTextContent(v);
          } else {
              // 处理 MultimodalContent[] (包含 Base64 URL)
              // TODO: 确认腾讯混元 API 对多模态 content 的具体格式要求。
              // 假设它接受类似 OpenAI 的数组格式，但需要验证。
              // 这里暂时直接使用 preProcessMultimodalContent 的输出。
              content = processedContent.map(part => {
                 if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
                    // 假设 API 接受 { type: "image_url", image_url: { url: "base64_encoded_image" } }
                    // 或者需要解析 Base64: { type: "image", data: "...", mime_type: "..." }
                    // 暂时按 OpenAI 格式传递，如果 API 不兼容则需要修改
                    const base64Data = part.image_url.url.split(',')[1];
                    if (!base64Data) {
                       console.warn("[Tencent] Empty base64 data found for image.");
                       return { type: "text", text: "[Invalid Image Data]" };
                    }
                    // 示例：如果 API 需要 data 字段
                    // const mimeMatch = part.image_url.url.match(/data:(.*?);base64,/);
                    // const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
                    // return { type: "image", data: base64Data, mime_type: mimeType };

                    // 假设 API 接受 Base64 URL in image_url.url
                    // return part;
                    // 更有可能需要直接传递 Base64 字符串
                    return { type: "text", text: `[Image data: ${base64Data.substring(0, 30)}...]` }; // 临时表示
                    // 或者如果 API 支持内联数据
                    // return { type: "image", data: base64Data }; // 假设结构
                 }
                 return part; // 保留 text 或其他部分
              }).filter(part => part.type !== 'image_url' || (part.image_url?.url && !part.image_url.url.startsWith('data:'))); // 过滤掉未处理的 Base64 图片

              // 如果处理后只剩下一个文本部分，简化为字符串
              if (content.length === 1 && content[0].type === 'text') {
                 content = content[0].text ?? "";
              } else if (content.length === 0) {
                 content = "[Empty message content after processing]";
              }
          }
          // 使用 API 的大写字段名
          return { Role: capitalizeFirstLetter(role), Content: content };
      }));

      const modelConfig = {
        ...useAppConfig.getState().modelConfig,
        ...useChatStore.getState().currentSession().mask.modelConfig,
        ...{
          model: options.config.model,
        },
      };

      // 构建请求体，字段名大写
      const requestPayload: RequestPayload = {
        Model: modelConfig.model,
        Messages: messages, // 直接使用处理过的 messages
        Temperature: modelConfig.temperature,
        TopP: modelConfig.top_p,
        Stream: options.config.stream,
      };

      console.log("[Request] Tencent payload: ", requestPayload);

      const shouldStream = !!options.config.stream;
      const controller = new AbortController();
      options.onController?.(controller);

      try {
        const chatPath = this.path(); // Base URL is the endpoint
        // Tencent API 需要 SigV3 签名，这通常在后端完成
        // 前端直接调用可能需要后端代理来处理签名
        // getHeaders() 可能需要包含签名信息，或者由代理添加
        const headers = await getTencentHeaders(requestPayload); // 假设有函数生成签名头

        const chatPayload = {
          method: "POST",
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
          headers: headers, // 使用包含签名的头
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
              if (responseText?.length === 0 && !controller.signal.aborted) {
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

          // start animation
          animateResponseText();

          const finish = () => {
            if (!finished) {
              finished = true;
              options.onFinish(responseText + remainText, responseRes);
            }
          };

          controller.signal.onabort = finish;

          fetchEventSource(chatPath, {
            fetch: fetch as any, // Use global or imported fetch
            ...chatPayload,
            async onopen(res) {
              clearTimeout(requestTimeoutId);
              const contentType = res.headers.get("content-type");
              console.log(
                "[Tencent] request response content type: ",
                contentType,
              );
              responseRes = res;

              // Handle plain text or JSON error responses
              if (contentType?.startsWith("text/plain") || contentType?.startsWith("application/json")) {
                responseText = await res.clone().text();
                try {
                   const resJson = JSON.parse(responseText);
                   // TODO: 确认腾讯 API 的错误结构
                   if (resJson.Response?.Error) {
                      console.error("[Tencent API Error]", resJson.Response.Error);
                      options.onError?.(new Error(resJson.Response.Error.Message || `Tencent API Error Code: ${resJson.Response.Error.Code}`));
                   }
                } catch {
                   // Not a JSON error
                }
                return finish();
              }

              // Handle stream errors
              if (
                !res.ok ||
                !res.headers
                  .get("content-type")
                  ?.startsWith(EventStreamContentType) ||
                res.status !== 200
              ) {
                let extraInfo = await res.clone().text();
                try {
                  const resJson = await res.clone().json();
                  extraInfo = prettyObject(resJson);
                  // TODO: 确认错误结构
                  if (resJson.Response?.Error) {
                     options.onError?.(new Error(resJson.Response.Error.Message || `Tencent API Error Code: ${resJson.Response.Error.Code}`));
                  }
                } catch {}

                if (res.status === 401) { // Or other auth errors
                  extraInfo = Locale.Error.Unauthorized;
                }

                options.onError?.(
                  new Error(
                    `Request failed with status ${res.status}: ${extraInfo}`,
                  ),
                );
                return finish();
              }
            },
            onmessage(msg) {
              // TODO: 确认腾讯 SSE 结束标志
              if (/* msg.data === "[DONE]" || */ finished) {
                // finish(); // Let onclose handle finish
                return;
              }
              const text = msg.data;
              try {
                const json = JSON.parse(text);
                // TODO: 确认腾讯 SSE 响应结构
                if (json.Response?.Error) {
                   console.error("[Tencent Stream Error]", json.Response.Error);
                   options.onError?.(new Error(json.Response.Error.Message || `Tencent API Error Code: ${json.Response.Error.Code}`));
                   finish();
                   return;
                }
                const choices = json.Choices as Array<{ // 注意是 Choices
                  Delta: { Content: string };
                }>;
                const delta = choices?.[0]?.Delta?.Content;
                if (delta) {
                  remainText += delta;
                }
                // TODO: 确认腾讯流结束条件 (可能没有特定标志，依赖 onclose)
                // if (json.is_end) { finish(); }
              } catch (e) {
                console.error("[Request] parse error", text, msg, e);
              }
            },
            onclose() {
              finish(); // Ensure finish is called
            },
            onerror(e) {
              options.onError?.(e);
              throw e; // Re-throw for fetchEventSource
            },
            openWhenHidden: true,
          });
        } else {
          // Non-streaming request
          const res = await fetch(chatPath, chatPayload); // Use global or imported fetch
          clearTimeout(requestTimeoutId);

          const resJson = await res.json();

          // TODO: 确认腾讯 API 错误结构
          if (resJson.Response?.Error) {
             console.error("[Tencent API Error]", resJson.Response.Error);
             options.onError?.(new Error(resJson.Response.Error.Message || `Tencent API Error Code: ${resJson.Response.Error.Code}`));
             return;
          }

          const message = this.extractMessage(resJson); // 确认 extractMessage 能处理大写字段
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
