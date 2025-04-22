"use client";
import { ApiPath, Alibaba, ALIBABA_BASE_URL } from "@/app/constant";
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
  MultimodalContent,
  MultimodalContentForAlibaba,
} from "../api";
import { getClientConfig } from "@/app/config/client";
import {
  getMessageTextContent,
  getMessageTextContentWithoutThinking,
  getTimeoutMSByModel,
  isVisionModel,
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

interface RequestInput {
  messages: {
    role: "system" | "user" | "assistant";
    content: string | MultimodalContent[];
  }[];
}
interface RequestParam {
  result_format: string;
  incremental_output?: boolean;
  temperature: number;
  repetition_penalty?: number;
  top_p: number;
  max_tokens?: number;
}
interface RequestPayload {
  model: string;
  input: RequestInput;
  parameters: RequestParam;
}

export class QwenApi implements LLMApi {
  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.alibabaUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      baseUrl = isApp ? ALIBABA_BASE_URL : ApiPath.Alibaba;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.Alibaba)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    return [baseUrl, path].join("/");
  }

  extractMessage(res: any) {
    return res?.output?.choices?.at(0)?.message?.content ?? "";
  }

  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  async chat(options: ChatOptions) {
    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
      },
    };

    const visionModel = isVisionModel(options.config.model);

    // messages 直接使用 options.messages，预处理已在外部完成
    // 但需要在这里根据 API 要求转换 content 格式
    const messages = options.messages.map(v => {
        const role = v.role;
        let content: string | MultimodalContentForAlibaba[]; // API 期望的格式

        if (typeof v.content === 'string' || !visionModel) {
            // 如果是字符串或非视觉模型，获取纯文本
            content = v.role === "assistant"
                      ? getMessageTextContentWithoutThinking(v)
                      : getMessageTextContent(v);
        } else {
            // 处理 MultimodalContent[]
            content = v.content.map(part => {
                if (part.type === 'text') {
                    return { text: part.text ?? "" };
                } else if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
                    // 图像部分，直接使用 Base64 URL
                    return { image: part.image_url.url };
                } else {
                    // 其他类型或无效图像 URL，转换为文本提示
                    const description = part.type === 'image_url' ? 'Image' : part.file_url?.name ?? 'File';
                    console.warn(`[Alibaba] Omitting or invalid content part: ${description}`);
                    return { text: `[${description} content omitted or invalid]` };
                }
            }).filter(item => item.text !== undefined || item.image !== undefined); // 过滤掉无效转换结果

            // 如果处理后只剩下一个文本部分，简化为字符串
            if (content.length === 1 && content[0].text !== undefined) {
               content = content[0].text;
            }
            // 如果处理后为空数组 (例如只有无效部分)，则设为空字符串或提示
            if (content.length === 0) {
               content = "[Empty message content after processing]";
            }
        }
        return { role, content };
    });

    const shouldStream = !!options.config.stream;
    const requestPayload: RequestPayload = {
      model: modelConfig.model,
      input: {
        messages: messages as any, // 需要断言，因为 content 类型已转换
      },
      parameters: {
        result_format: "message",
        incremental_output: shouldStream,
        temperature: modelConfig.temperature,
        // max_tokens: modelConfig.max_tokens, // 通常由模型决定或在流式传输中不直接设置
        top_p: modelConfig.top_p === 1 ? 0.99 : modelConfig.top_p, // qwen top_p is should be < 1
      },
    };

    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const headers = {
        ...getHeaders(),
        "X-DashScope-SSE": shouldStream ? "enable" : "disable",
      };

      const chatPath = this.path(Alibaba.ChatPath(modelConfig.model));
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: headers,
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
        return streamWithThink(
          chatPath,
          requestPayload,
          headers,
          tools as any,
          funcs,
          controller,
          // parseSSE
          (text: string, runTools: ChatMessageTool[]) => {
            let json;
            try {
               json = JSON.parse(text);
            } catch (e) {
               console.error("[Alibaba SSE Parse Error]", text, e);
               return { isThinking: false, content: "" }; // Return empty on parse error
            }

            const choices = json.output?.choices as Array<{
              message: {
                content: string | null | MultimodalContentForAlibaba[];
                tool_calls: ChatMessageTool[];
                reasoning_content: string | null;
              };
            }>;

            if (!choices?.length) return { isThinking: false, content: "" };

            const tool_calls = choices[0]?.message?.tool_calls;
            if (tool_calls?.length > 0) {
              const index = tool_calls[0]?.index; // Assuming index is for aggregation
              const id = tool_calls[0]?.id;
              const args = tool_calls[0]?.function?.arguments;
              if (id) { // Start of a new tool call
                runTools.push({
                  id,
                  type: tool_calls[0]?.type,
                  function: {
                    name: tool_calls[0]?.function?.name as string,
                    arguments: args || "", // Initialize arguments
                  },
                });
              } else if (index !== undefined && runTools[index]) { // Aggregating arguments
                runTools[index].function!.arguments += args || "";
              } else {
                 console.warn("[Alibaba] Tool call aggregation error: missing id or index", tool_calls[0]);
              }
            }

            const reasoning = choices[0]?.message?.reasoning_content;
            const content = choices[0]?.message?.content;

            // Skip if both content and reasoning_content are empty or null
            if (
              (!reasoning || reasoning.length === 0) &&
              (!content || (Array.isArray(content) && content.length === 0) || (typeof content === 'string' && content.length === 0))
            ) {
              return {
                isThinking: false,
                content: "",
              };
            }

            if (reasoning && reasoning.length > 0) {
              return {
                isThinking: true,
                content: reasoning,
              };
            } else if (content) {
              return {
                isThinking: false,
                content: Array.isArray(content)
                  ? content.map((item) => item.text ?? "").join("") // Extract and join text from array
                  : content, // Use string content directly
              };
            }

            return {
              isThinking: false,
              content: "",
            };
          },
          // processToolMessage, include tool_calls message and tool call results
          (
            requestPayload: RequestPayload,
            toolCallMessage: any,
            toolCallResult: any[],
          ) => {
            // Append tool call message and results to the input messages
            requestPayload?.input?.messages?.push(
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

        if (resJson.code) { // Check for API errors
           console.error("Alibaba API Error:", resJson);
           options.onError?.(new Error(resJson.message || `Alibaba API Error Code: ${resJson.code}`));
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
export { Alibaba };
