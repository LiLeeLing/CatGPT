"use client";
import { ApiPath, CHATGLM_BASE_URL, ChatGLM } from "@/app/constant";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
  ChatMessageTool,
  usePluginStore,
} from "@/app/store";
import { stream } from "@/app/utils/chat";
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
  isVisionModel,
  getTimeoutMSByModel,
} from "@/app/utils";
import { RequestPayload } from "./openai";
import { fetch } from "@/app/utils/stream";
import { preProcessMultimodalContent } from "@/app/utils/chat";

interface BasePayload {
  model: string;
}

interface ChatPayload extends BasePayload {
  messages: ChatOptions["messages"];
  stream?: boolean;
  temperature?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  top_p?: number;
}

interface ImageGenerationPayload extends BasePayload {
  prompt: string;
  size?: string;
  user_id?: string;
}

interface VideoGenerationPayload extends BasePayload {
  prompt: string;
  duration?: number;
  resolution?: string;
  user_id?: string;
}

type ModelType = "chat" | "image" | "video";

export class ChatGLMApi implements LLMApi {
  private disableListModels = true;

  private getModelType(model: string): ModelType {
    if (model.startsWith("cogview-")) return "image";
    if (model.startsWith("cogvideo-")) return "video";
    return "chat";
  }

  private getModelPath(type: ModelType): string {
    switch (type) {
      case "image":
        return ChatGLM.ImagePath;
      case "video":
        return ChatGLM.VideoPath;
      default:
        return ChatGLM.ChatPath;
    }
  }

  private createPayload(
    messages: ChatOptions["messages"],
    modelConfig: any,
    options: ChatOptions,
  ): BasePayload {
    const modelType = this.getModelType(modelConfig.model);
    const lastMessage = messages[messages.length - 1];
    const prompt =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : lastMessage.content.map((c) => c.text).join("\n");

    switch (modelType) {
      case "image":
        return {
          model: modelConfig.model,
          prompt,
          size: options.config.size,
        } as ImageGenerationPayload;
      default:
        return {
          messages,
          stream: options.config.stream,
          model: modelConfig.model,
          temperature: modelConfig.temperature,
          presence_penalty: modelConfig.presence_penalty,
          frequency_penalty: modelConfig.frequency_penalty,
          top_p: modelConfig.top_p,
        } as ChatPayload;
    }
  }

  private parseResponse(modelType: ModelType, json: any): string {
    switch (modelType) {
      case "image": {
        const imageUrl = json.data?.[0]?.url;
        return imageUrl ? `![Generated Image](${imageUrl})` : "";
      }
      case "video": {
        const videoUrl = json.data?.[0]?.url;
        return videoUrl ? `<video controls src="${videoUrl}"></video>` : "";
      }
      default:
        return this.extractMessage(json);
    }
  }

  path(path: string): string {
    const accessStore = useAccessStore.getState();
    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.chatglmUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = ApiPath.ChatGLM;
      baseUrl = isApp ? CHATGLM_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.ChatGLM)) {
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
          if (!visionModel && typeof v.content !== 'string') {
              // 如果模型不支持视觉，且 content 不是字符串，则提取文本
              return {
                  role: v.role,
                  content: getMessageTextContent(v)
              };
          } else if (visionModel && Array.isArray(v.content)) {
              // 如果是视觉模型且 content 是数组，检查并处理 Base64
              // TODO: 确认 ChatGLM API (glm-4v) 接受的格式，可能需要转换
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
      const modelType = this.getModelType(modelConfig.model);
      // 使用处理过的 messages 创建 payload
      const requestPayload = this.createPayload(messages, modelConfig, options);
      const path = this.path(this.getModelPath(modelType));

      console.log(`[Request] glm ${modelType} payload: `, requestPayload);

      const controller = new AbortController();
      options.onController?.(controller);

      try {
        const chatPayload = {
          method: "POST",
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
          headers: getHeaders(),
        };

        const requestTimeoutId = setTimeout(
          () => controller.abort(),
          getTimeoutMSByModel(options.config.model),
        );

        // Handle image/video generation (non-streaming)
        if (modelType === "image" || modelType === "video") {
          const res = await fetch(path, chatPayload); // Use global or imported fetch
          clearTimeout(requestTimeoutId);

          const resJson = await res.json();
          console.log(`[Response] glm ${modelType}:`, resJson);

          // TODO: 确认 ChatGLM API 的错误格式
          if (resJson.error) {
             console.error(`ChatGLM ${modelType} Error:`, resJson.error);
             options.onError?.(new Error(resJson.error.message || `ChatGLM ${modelType} error`));
             return;
          }

          const message = this.parseResponse(modelType, resJson);
          options.onFinish(message, res);
          return;
        }

        // Handle chat completion (streaming or non-streaming)
        const shouldStream = !!options.config.stream;
        if (shouldStream) {
          const [tools, funcs] = usePluginStore
            .getState()
            .getAsTools(
              useChatStore.getState().currentSession().mask?.plugin || [],
            );
          // 假设 ChatGLM API 结构类似 OpenAI，使用 stream
          return stream( // ChatGLM 可能不支持 streamWithThink
            path,
            requestPayload, // 传递的是 ChatPayload
            getHeaders(),
            tools as any, // TODO: 确认 ChatGLM API 的 tools 格式
            funcs,
            controller,
            // parseSSE - 假设类似 OpenAI
            (text: string, runTools: ChatMessageTool[]) => {
              let json;
              try {
                 json = JSON.parse(text);
              } catch (e) {
                 console.error("[ChatGLM SSE Parse Error]", text, e);
                 return undefined;
              }

              const choices = json.choices as Array<{
                delta: {
                  content: string | null;
                  tool_calls?: ChatMessageTool[];
                };
              }>;

              if (!choices?.length) return undefined;

              const delta = choices[0]?.delta;
              const tool_calls = delta?.tool_calls;
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

              return content ?? undefined; // 返回 content 或 undefined
            },
            // processToolMessage - 假设类似 OpenAI
            (
              reqPayload: ChatPayload, // 使用 ChatPayload 类型
              toolCallMessage: any,
              toolCallResult: any[],
            ) => {
              reqPayload?.messages?.push(
                toolCallMessage,
                ...toolCallResult,
              );
            },
            options,
          );
        } else {
          // Non-streaming chat request
          const res = await fetch(path, chatPayload); // Use global or imported fetch
          clearTimeout(requestTimeoutId);

          const resJson = await res.json();

          // TODO: 确认 ChatGLM API 的错误格式
          if (resJson.error) {
             console.error("ChatGLM API Error:", resJson.error);
             options.onError?.(new Error(resJson.error.message || "ChatGLM API error"));
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
