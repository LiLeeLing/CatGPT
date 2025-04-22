"use client";
import {
  ApiPath,
  IFLYTEK_BASE_URL,
  Iflytek,
  REQUEST_TIMEOUT_MS,
} from "@/app/constant";
import { useAccessStore, useAppConfig, useChatStore } from "@/app/store";

import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  SpeechOptions,
} from "../api";
import Locale from "../../locales";
import {
  EventStreamContentType,
  fetchEventSource,
} from "@fortaine/fetch-event-source";
import { prettyObject } from "@/app/utils/format";
import { getClientConfig } from "@/app/config/client";
import { getMessageTextContent } from "@/app/utils";
import { fetch } from "@/app/utils/stream";

import { RequestPayload } from "./openai";

export class SparkApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.iflytekUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = ApiPath.Iflytek;
      baseUrl = isApp ? IFLYTEK_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.Iflytek)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    return [baseUrl, path].join("/");
  }

  extractMessage(res: any) {
    return res.choices?.at(0)?.message?.content ?? "";
  }

  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  // --- 替换整个 chat 方法 ---
    async chat(options: ChatOptions) {
      // 讯飞星火当前似乎只处理文本，保持现有逻辑
      const messages: ChatOptions["messages"] = [];
      for (const v of options.messages) {
        const content = getMessageTextContent(v); // 保持 getMessageTextContent 调用
        messages.push({ role: v.role, content });
      }

      const modelConfig = {
        ...useAppConfig.getState().modelConfig,
        ...useChatStore.getState().currentSession().mask.modelConfig,
        ...{
          model: options.config.model,
          providerName: options.config.providerName,
        },
      };

      // 讯飞 API 的 payload 结构可能不同，这里假设类似 OpenAI
      const requestPayload: RequestPayload = {
        messages,
        stream: options.config.stream,
        model: modelConfig.model, // 需要确认 API 使用的字段名
        temperature: modelConfig.temperature,
        // presence_penalty: modelConfig.presence_penalty, // 确认支持
        // frequency_penalty: modelConfig.frequency_penalty, // 确认支持
        top_p: modelConfig.top_p, // 确认支持
        // max_tokens: modelConfig.max_tokens, // 确认支持
      };

      console.log("[Request] Spark payload: ", requestPayload);

      const shouldStream = !!options.config.stream;
      const controller = new AbortController();
      options.onController?.(controller);

      try {
        const chatPath = this.path(Iflytek.ChatPath); // 确认路径
        const chatPayload = {
          method: "POST",
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
          headers: getHeaders(), // 可能需要特定的认证头
        };

        // Make a fetch request
        const requestTimeoutId = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS, // 使用默认超时或根据模型调整
        );

        if (shouldStream) {
          let responseText = "";
          let remainText = "";
          let finished = false;
          let responseRes: Response;

          // Animate response text to make it look smooth
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

          // Start animation
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
              console.log("[Spark] request response content type: ", contentType);
              responseRes = res;

              // Handle plain text or JSON error responses
              if (contentType?.startsWith("text/plain") || contentType?.startsWith("application/json")) {
                responseText = await res.clone().text();
                try {
                   const resJson = JSON.parse(responseText);
                   // TODO: 确认讯飞 API 的错误结构
                   if (resJson.header?.code !== 0) {
                      console.error("[Spark API Error]", resJson);
                      options.onError?.(new Error(resJson.header?.message || `Spark API Error Code: ${resJson.header?.code}`));
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
                  if (resJson.header?.code !== 0) {
                     options.onError?.(new Error(resJson.header?.message || `Spark API Error Code: ${resJson.header?.code}`));
                  }
                } catch {}

                if (res.status === 401) {
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
              // TODO: 确认讯飞 SSE 结束标志
              if (/* msg.data === "[DONE]" || */ finished) {
                // finish(); // Let onclose handle finish
                return;
              }
              const text = msg.data;
              try {
                const json = JSON.parse(text);
                // TODO: 确认讯飞 SSE 响应结构
                if (json.header?.code !== 0) {
                   console.error("[Spark Stream Error]", json);
                   options.onError?.(new Error(json.header?.message || `Spark API Error Code: ${json.header?.code}`));
                   finish();
                   return;
                }
                const choices = json.payload?.choices?.text as Array<{
                  content: string;
                  // role: string;
                  // index: number;
                }>;
                const delta = choices?.map(c => c.content).join("") ?? "";

                if (delta) {
                  remainText += delta;
                }
                // TODO: 确认讯飞流结束条件
                if (json.header?.status === 2) {
                   finish();
                }
              } catch (e) {
                console.error("[Request] parse error", text, e);
                // options.onError?.(new Error(`Failed to parse response: ${text}`));
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

          // TODO: 确认讯飞 API 错误结构
          if (resJson.header?.code !== 0) {
             console.error("[Spark API Error]", resJson);
             options.onError?.(new Error(resJson.header?.message || `Spark API Error Code: ${resJson.header?.code}`));
             return;
          }

          // TODO: 确认讯飞非流式响应结构以提取消息
          const message = this.extractMessage(resJson); // 可能需要调整 extractMessage
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
