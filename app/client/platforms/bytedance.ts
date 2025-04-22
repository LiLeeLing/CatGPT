"use client";
import { ApiPath, ByteDance, BYTEDANCE_BASE_URL } from "@/app/constant";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
  ChatMessageTool,
  usePluginStore,
} from "@/app/store";

import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  MultimodalContent,
  SpeechOptions,
} from "../api";

import { streamWithThink } from "@/app/utils/chat";
import { getClientConfig } from "@/app/config/client";
import { preProcessMultimodalContent } from "@/app/utils/chat";
import {
  getMessageTextContentWithoutThinking,
  getTimeoutMSByModel,
} from "@/app/utils";
import { fetch } from "@/app/utils/stream";

export interface OpenAIListModelResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    root: string;
  }>;
}

interface RequestPayloadForByteDance {
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

export class DoubaoApi implements LLMApi {
  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.bytedanceUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      baseUrl = isApp ? BYTEDANCE_BASE_URL : ApiPath.ByteDance;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.ByteDance)) {
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
      const visionModel = isVisionModel(options.config.model); // 检查模型是否支持视觉

      // messages 直接使用 options.messages，预处理已在外部完成
      // 但需要根据模型能力过滤或转换 content
      const messages = options.messages.map(v => {
          if (!visionModel && typeof v.content !== 'string') {
              // 如果模型不支持视觉，且 content 不是字符串，则提取文本
              return {
                  role: v.role,
                  content: v.role === "assistant"
                           ? getMessageTextContentWithoutThinking(v)
                           : getMessageTextContent(v)
              };
          } else if (visionModel && Array.isArray(v.content)) {
              // 如果是视觉模型且 content 是数组，检查并处理 Base64
              // TODO: 确认豆包 API 接受的格式，可能需要转换
              const processedParts = v.content.map(part => {
                  if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
                      // 假设 API 接受 { type: "image_url", image_url: { url: "data:..." } }
                      // 如果需要转换，在这里进行
                      // 例如: return { type: "image", source: { type: "base64", media_type: "...", data: "..." } };
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
        },
      };

      const shouldStream = !!options.config.stream;
      const requestPayload: RequestPayloadForByteDance = {
        messages: messages as any, // 使用处理过的 messages, 需要断言类型
        stream: shouldStream,
        model: modelConfig.model,
        temperature: modelConfig.temperature,
        presence_penalty: modelConfig.presence_penalty,
        frequency_penalty: modelConfig.frequency_penalty,
        top_p: modelConfig.top_p,
        // max_tokens: modelConfig.max_tokens, // 根据 API 文档确认是否支持
      };

      const controller = new AbortController();
      options.onController?.(controller);

      try {
        const chatPath = this.path(ByteDance.ChatPath);
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
          const [tools, funcs] = usePluginStore
            .getState()
            .getAsTools(
              useChatStore.getState().currentSession().mask?.plugin || [],
            );
          // TODO: 确认豆包 API 是否支持 streamWithThink 的 reasoning_content
          // 如果不支持，可能需要使用普通的 stream 函数
          return streamWithThink( // 或者 stream()
            chatPath,
            requestPayload,
            getHeaders(),
            tools as any, // TODO: 确认豆包 API 的 tools 格式
            funcs,
            controller,
            // parseSSE - 需要根据豆包 API 的 SSE 格式调整
            (text: string, runTools: ChatMessageTool[]) => {
              let json;
              try {
                 json = JSON.parse(text);
              } catch (e) {
                 console.error("[ByteDance SSE Parse Error]", text, e);
                 return { isThinking: false, content: "" };
              }

              // TODO: 确认豆包 API 的 SSE 结构
              const choices = json.choices as Array<{
                delta: {
                  content: string | null;
                  tool_calls?: ChatMessageTool[]; // 假设的工具调用结构
                  // reasoning_content?: string | null; // 假设的思考过程结构
                };
              }>;

              if (!choices?.length) return { isThinking: false, content: "" };

              const delta = choices[0]?.delta;
              const tool_calls = delta?.tool_calls;
              // const reasoning = delta?.reasoning_content; // 如果支持
              const content = delta?.content;

              if (tool_calls?.length > 0) {
                // TODO: 处理工具调用逻辑，类似其他平台
                const tool = tool_calls[0];
                const index = tool.index; // Assuming index for aggregation
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

              // if (reasoning && reasoning.length > 0) {
              //   return { isThinking: true, content: reasoning };
              // } else
              if (content && content.length > 0) {
                return { isThinking: false, content: content };
              }

              return { isThinking: false, content: "" };
            },
            // processToolMessage - 需要根据豆包 API 的格式调整
            (
              requestPayload: RequestPayloadForByteDance,
              toolCallMessage: any,
              toolCallResult: any[],
            ) => {
              // TODO: 调整以匹配豆包 API 的消息格式
              requestPayload?.messages?.push(
                toolCallMessage, // 可能需要转换格式
                ...toolCallResult, // 可能需要转换格式
              );
            },
            options,
          );
        } else {
          // Non-streaming request
          const res = await fetch(chatPath, chatPayload); // Use global or imported fetch
          clearTimeout(requestTimeoutId);

          const resJson = await res.json();

          // TODO: 确认豆包 API 的错误格式
          if (resJson.error) {
             console.error("ByteDance API Error:", resJson.error);
             options.onError?.(new Error(resJson.error.message || "ByteDance API error"));
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
    return [];
  }
}
export { ByteDance };
