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
     const messages = options.messages.map((v) => ({
       // "error_code": 336006, "error_msg": "the role of message with even index in the messages must be user or function",
       role: v.role === "system" ? "user" : v.role,
       content: getMessageTextContent(v), // 保持 getMessageTextContent 调用
     }));

     // "error_code": 336006, "error_msg": "the length of messages must be an odd number",
     // 确保消息列表长度为奇数
     if (messages.length % 2 === 0) {
       if (messages.length > 0 && messages[0]?.role === "user") {
         // 如果第一条是 user，在后面插入 assistant 占位符
         messages.splice(1, 0, {
           role: "assistant",
           content: " ", // 使用空格或其他占位符
         });
       } else {
         // 否则在开头插入 user 占位符
         messages.unshift({
           role: "user",
           content: " ", // 使用空格或其他占位符
         });
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
       // max_tokens: modelConfig.max_tokens, // Baidu API 可能不支持或有不同名称
     };

     console.log("[Request] Baidu payload: ", requestPayload);

     const controller = new AbortController();
     options.onController?.(controller);

     try {
       let chatPath = this.path(Baidu.ChatPath(modelConfig.model));

       // getAccessToken can not run in browser, because cors error
       // Only attempt token generation if in an environment where it's possible (e.g., Tauri app)
       if (!!getClientConfig()?.isApp) {
         const accessStore = useAccessStore.getState();
         if (accessStore.useCustomConfig && accessStore.isValidBaidu()) {
           try {
              const { access_token } = await getAccessToken(
                accessStore.baiduApiKey,
                accessStore.baiduSecretKey,
              );
              chatPath = `${chatPath}${
                chatPath.includes("?") ? "&" : "?"
              }access_token=${access_token}`;
           } catch (tokenError) {
              console.error("[Baidu Auth] Failed to get access token:", tokenError);
              // Decide how to handle token error: proceed without token, or throw error?
              // options.onError?.(new Error("Failed to get Baidu access token"));
              // return; // Or maybe proceed without token if API allows IP whitelist etc.
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
             if (responseText?.length === 0 && !controller.signal.aborted) { // Check if not aborted
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
             console.log("[Baidu] request response content type: ", contentType);
             responseRes = res;
             if (contentType?.startsWith("text/plain") || contentType?.startsWith("application/json")) { // Handle JSON errors too
               responseText = await res.clone().text();
               try {
                  const resJson = JSON.parse(responseText);
                  if (resJson.error_code) {
                     console.error("[Baidu API Error]", resJson);
                     options.onError?.(new Error(resJson.error_msg || `Baidu API Error Code: ${resJson.error_code}`));
                  }
               } catch {
                  // Not a JSON error, likely plain text
               }
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
                 if (resJson.error_code) {
                    options.onError?.(new Error(resJson.error_msg || `Baidu API Error Code: ${resJson.error_code}`));
                 }
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
             if (msg.data === "[DONE]" || finished) { // Baidu might not send [DONE]
               // finish(); // Let onclose handle finish
               return;
             }
             const text = msg.data;
             try {
               const json = JSON.parse(text);
               if (json.error_code) {
                  console.error("[Baidu Stream Error]", json);
                  options.onError?.(new Error(json.error_msg || `Baidu API Error Code: ${json.error_code}`));
                  finish(); // Finish on error
                  return;
               }
               const delta = json?.result;
               if (delta) {
                 remainText += delta;
               }
               if (json.is_end) { // Check for Baidu's end flag
                  finish();
               }
             } catch (e) {
               console.error("[Request] parse error", text, msg, e);
               // Handle potential final non-JSON message if needed
               if (text.includes("Final Answer:")) { // Example check
                  remainText += text;
               }
             }
           },
           onclose() {
             finish(); // Ensure finish is called when the stream closes
           },
           onerror(e) {
             options.onError?.(e);
             throw e; // Re-throw error for fetchEventSource
           },
           openWhenHidden: true,
         });
       } else {
         // Non-streaming request
         const res = await fetch(chatPath, chatPayload); // Use global or imported fetch
         clearTimeout(requestTimeoutId);

         const resJson = await res.json();

         if (resJson.error_code) {
            console.error("[Baidu API Error]", resJson);
            options.onError?.(new Error(resJson.error_msg || `Baidu API Error Code: ${resJson.error_code}`));
            return;
         }

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
