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
import { preProcessImageContent } from "@/app/utils/chat";

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
    // --- 开始: 通用修改逻辑 (适配 GLM) ---
    const processedMessages: ChatOptions["messages"] = [];
    for (const v of options.messages) {
      let processedContent: string | MultimodalContent[];
      const modelConfigForCheck = { ...useAppConfig.getState().modelConfig, ...useChatStore.getState().currentSession().mask.modelConfig, ...{ model: options.config.model } };
      const visionModel = isVisionModel(modelConfigForCheck.model);

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
               // GLM API 格式未知，暂时使用 OpenAI 格式
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
          // GLM API 可能接受数组，保持数组结构
          processedContent = filteredContent;
        } else {
          processedContent = getMessageTextContent(v);
        }

         if (v.role === "assistant" && typeof getMessageTextContentWithoutThinking === 'function') {
             if (typeof processedContent === 'string') {
                 processedContent = getMessageTextContentWithoutThinking({ role: v.role, content: processedContent });
             } else if (Array.isArray(processedContent)) {
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
      processedMessages.push({ role: v.role, content });
    }
    // --- 结束: 通用修改逻辑 ---

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
        providerName: options.config.providerName,
      },
    };
    const modelType = this.getModelType(modelConfig.model);
    // 使用 processedMessages 替换旧的 messages
    const requestPayload = this.createPayload(processedMessages, modelConfig, options);
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

      if (modelType === "image" || modelType === "video") {
        const res = await fetch(path, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();
        console.log(`[Response] glm ${modelType}:`, resJson);
        const message = this.parseResponse(modelType, resJson);
        options.onFinish(message, res);
        return;
      }

      const shouldStream = !!options.config.stream;
      if (shouldStream) {
        const [tools, funcs] = usePluginStore
          .getState()
          .getAsTools(
            useChatStore.getState().currentSession().mask?.plugin || [],
          );
        return stream(
          path,
          requestPayload,
          getHeaders(),
          tools as any,
          funcs,
          controller,
          // parseSSE
          (text: string, runTools: ChatMessageTool[]) => {
            const json = JSON.parse(text);
            const choices = json.choices as Array<{
              delta: {
                content: string;
                tool_calls: ChatMessageTool[];
              };
            }>;
            const tool_calls = choices[0]?.delta?.tool_calls;
            if (tool_calls?.length > 0) {
              const index = tool_calls[0]?.index;
              const id = tool_calls[0]?.id;
              const args = tool_calls[0]?.function?.arguments;
              if (id) {
                runTools.push({
                  id,
                  type: tool_calls[0]?.type,
                  function: {
                    name: tool_calls[0]?.function?.name as string,
                    arguments: args,
                  },
                });
              } else {
                // @ts-ignore
                runTools[index]["function"]["arguments"] += args;
              }
            }
            return choices[0]?.delta?.content;
          },
          // processToolMessage
          (
            requestPayload: RequestPayload,
            toolCallMessage: any,
            toolCallResult: any[],
          ) => {
            // @ts-ignore
            requestPayload?.messages?.splice(
              // @ts-ignore
              requestPayload?.messages?.length,
              0,
              toolCallMessage,
              ...toolCallResult,
            );
          },
          options,
        );
      } else {
        const res = await fetch(path, chatPayload);
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
