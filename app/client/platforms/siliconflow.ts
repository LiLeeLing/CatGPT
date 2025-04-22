"use client";
// azure and openai, using same models. so using same LLMApi.
import {
  ApiPath,
  SILICONFLOW_BASE_URL,
  SiliconFlow,
  DEFAULT_MODELS,
} from "@/app/constant";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
  ChatMessageTool,
  usePluginStore,
} from "@/app/store";
import { preProcessMultimodalContent, streamWithThink } from "@/app/utils/chat";
import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  SpeechOptions,
} from "../api";
import { getClientConfig } from "@/app/config/client";
import {
  getMessageTextContent,
  getMessageTextContentWithoutThinking,
  isVisionModel,
  getTimeoutMSByModel,
} from "@/app/utils";
import { RequestPayload } from "./openai";

import { fetch } from "@/app/utils/stream";
export interface SiliconFlowListModelResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    root: string;
  }>;
}

export class SiliconflowApi implements LLMApi {
  private disableListModels = false;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.siliconflowUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = ApiPath.SiliconFlow;
      baseUrl = isApp ? SILICONFLOW_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (
      !baseUrl.startsWith("http") &&
      !baseUrl.startsWith(ApiPath.SiliconFlow)
    ) {
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

    async chat(options: ChatOptions) {
      const visionModel = isVisionModel(options.config.model);

      // messages 直接使用 options.messages，预处理已在外部完成
      // 但需要根据模型能力过滤或转换 content
      const messages = options.messages.map(v => {
          if (v.role === "assistant") {
               // Assistants don't send images/files, handle thinking state
               return { role: v.role, content: getMessageTextContentWithoutThinking(v) };
          } else if (!visionModel && typeof v.content !== 'string') {
              // 如果模型不支持视觉，且 content 不是字符串，则提取文本
              return { role: v.role, content: getMessageTextContent(v) };
          } else if (visionModel && Array.isArray(v.content)) {
              // 如果是视觉模型且 content 是数组，检查并处理 Base64
              // TODO: 确认 SiliconFlow API 接受的格式，可能需要转换
              const processedParts = v.content.map(part => {
                  if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
                      // 假设 API 接受 { type: "image_url", image_url: { url: "data:..." } }
                      // 如果需要转换，在这里进行
                      return part;
                  }
                  return part; // 保留 text 或其他部分
              });
              return { ...v, content: processedParts };
          }
          // 对于视觉模型下的纯文本消息，或非视觉模型下的纯文本消息，直接使用
          return v;
      });

      const modelConfig = {
        ...useAppConfig.getState().modelConfig,
        ...useChatStore.getState().currentSession().mask.modelConfig,
        ...{
          model: options.config.model,
          providerName: options.config.providerName,
        },
      };

      // 假设 SiliconFlow API 结构类似 OpenAI
      const requestPayload: RequestPayload = {
        messages: messages as any, // 断言类型
        stream: options.config.stream,
        model: modelConfig.model,
        temperature: modelConfig.temperature,
        presence_penalty: modelConfig.presence_penalty,
        frequency_penalty: modelConfig.frequency_penalty,
        top_p: modelConfig.top_p,
        // max_tokens: modelConfig.max_tokens, // 根据 API 文档确认
      };

      console.log("[Request] siliconflow payload: ", requestPayload); // 更新日志名称

      const shouldStream = !!options.config.stream;
      const controller = new AbortController();
      options.onController?.(controller);

      try {
        const chatPath = this.path(SiliconFlow.ChatPath); // 确认路径
        const chatPayload = {
          method: "POST",
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
          headers: getHeaders(), // 可能需要特定的认证头
        };

        // Use extended timeout for thinking models if applicable, otherwise default
        const requestTimeoutId = setTimeout(
          () => controller.abort(),
          getTimeoutMSByModel(options.config.model),
        );

        if (shouldStream) {
          const [tools, funcs] = usePluginStore
            .getState()
            .getAsTools(
              useChatStore.getState().currentSession().mask?.plugin || [],
            );
          // 假设 SiliconFlow API 结构类似 OpenAI，使用 streamWithThink
          return streamWithThink(
            chatPath,
            requestPayload,
            getHeaders(),
            tools as any, // TODO: 确认 SiliconFlow API 的 tools 格式
            funcs,
            controller,
            // parseSSE - 假设类似 OpenAI
            (text: string, runTools: ChatMessageTool[]) => {
              let json;
              try {
                 json = JSON.parse(text);
              } catch (e) {
                 console.error("[SiliconFlow SSE Parse Error]", text, e);
                 return { isThinking: false, content: "" };
              }

              const choices = json.choices as Array<{
                delta: {
                  content: string | null;
                  tool_calls?: ChatMessageTool[];
                  reasoning_content?: string | null; // 假设可能支持
                };
              }>;

              if (!choices?.length) return { isThinking: false, content: "" };

              const delta = choices[0]?.delta;
              const tool_calls = delta?.tool_calls;
              const reasoning = delta?.reasoning_content;
              const content = delta?.content;

              if (tool_calls?.length > 0) {
                // 处理工具调用逻辑
                const tool = tool_calls[0];
                const index = tool.index;
                const id = tool.id;
                const args = tool.function?.arguments;
                if (id) {
                   runTools.push({
                     id,
                     type: tool.type,
                     function: { name: tool.function!.name, arguments: args || "" },
                   });
                } else if (index !== undefined && runTools[index]) {
                   runTools[index].function!.arguments += args || "";
                }
              }

              if (reasoning && reasoning.length > 0) {
                return { isThinking: true, content: reasoning };
              } else if (content && content.length > 0) {
                return { isThinking: false, content: content };
              }

              return { isThinking: false, content: "" };
            },
            // processToolMessage - 假设类似 OpenAI
            (
              requestPayload: RequestPayload,
              toolCallMessage: any,
              toolCallResult: any[],
            ) => {
              requestPayload?.messages?.push(
                toolCallMessage,
                ...toolCallResult,
              );
            },
            options,
          );
        } else {
          // Non-streaming request
          const res = await fetch(chatPath, chatPayload); // Use global or imported fetch
          clearTimeout(requestTimeoutId);

          const resJson = await res.json();

          // TODO: 确认 SiliconFlow API 的错误格式
          if (resJson.error) {
             console.error("SiliconFlow API Error:", resJson.error);
             options.onError?.(new Error(resJson.error.message || "SiliconFlow API error"));
             return;
          }

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
    if (this.disableListModels) {
      return DEFAULT_MODELS.slice();
    }

    const res = await fetch(this.path(SiliconFlow.ListModelPath), {
      method: "GET",
      headers: {
        ...getHeaders(),
      },
    });

    const resJson = (await res.json()) as SiliconFlowListModelResponse;
    const chatModels = resJson.data;
    console.log("[Models]", chatModels);

    if (!chatModels) {
      return [];
    }

    let seq = 1000; //同 Constant.ts 中的排序保持一致
    return chatModels.map((m) => ({
      name: m.id,
      available: true,
      sorted: seq++,
      provider: {
        id: "siliconflow",
        providerName: "SiliconFlow",
        providerType: "siliconflow",
        sorted: 14,
      },
    }));
  }
}
