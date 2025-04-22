import { Anthropic, ApiPath } from "@/app/constant";
import { ChatOptions, getHeaders, LLMApi, SpeechOptions } from "../api";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
  ChatMessageTool,
} from "@/app/store";
import { getClientConfig } from "@/app/config/client";
import { ANTHROPIC_BASE_URL } from "@/app/constant";
import { getMessageTextContent, isVisionModel } from "@/app/utils";
import { preProcessMultimodalContent, stream } from "@/app/utils/chat";
import { cloudflareAIGatewayUrl } from "@/app/utils/cloudflare";
import { RequestPayload } from "./openai";
import { fetch } from "@/app/utils/stream";

export type MultiBlockContent = {
  type: "image" | "text";
  source?: {
    type: string;
    media_type: string;
    data: string;
  };
  text?: string;
};

export type AnthropicMessage = {
  role: (typeof ClaudeMapper)[keyof typeof ClaudeMapper];
  content: string | MultiBlockContent[];
};

export interface AnthropicChatRequest {
  model: string; // The model that will complete your prompt.
  messages: AnthropicMessage[]; // The prompt that you want Claude to complete.
  max_tokens: number; // The maximum number of tokens to generate before stopping.
  stop_sequences?: string[]; // Sequences that will cause the model to stop generating completion text.
  temperature?: number; // Amount of randomness injected into the response.
  top_p?: number; // Use nucleus sampling.
  top_k?: number; // Only sample from the top K options for each subsequent token.
  metadata?: object; // An object describing metadata about the request.
  stream?: boolean; // Whether to incrementally stream the response using server-sent events.
}

export interface ChatRequest {
  model: string; // The model that will complete your prompt.
  prompt: string; // The prompt that you want Claude to complete.
  max_tokens_to_sample: number; // The maximum number of tokens to generate before stopping.
  stop_sequences?: string[]; // Sequences that will cause the model to stop generating completion text.
  temperature?: number; // Amount of randomness injected into the response.
  top_p?: number; // Use nucleus sampling.
  top_k?: number; // Only sample from the top K options for each subsequent token.
  metadata?: object; // An object describing metadata about the request.
  stream?: boolean; // Whether to incrementally stream the response using server-sent events.
}

export interface ChatResponse {
  completion: string;
  stop_reason: "stop_sequence" | "max_tokens";
  model: string;
}

export type ChatStreamResponse = ChatResponse & {
  stop?: string;
  log_id: string;
};

const ClaudeMapper = {
  assistant: "assistant",
  user: "user",
  system: "user",
} as const;

const keys = ["claude-2, claude-instant-1"];

export class ClaudeApi implements LLMApi {
  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  extractMessage(res: any) {
    console.log("[Response] claude response: ", res);

    return res?.content?.[0]?.text;
  }
    async chat(options: ChatOptions): Promise<void> {
      const visionModel = isVisionModel(options.config.model);
      const accessStore = useAccessStore.getState();
      const shouldStream = !!options.config.stream;

      const modelConfig = {
        ...useAppConfig.getState().modelConfig,
        ...useChatStore.getState().currentSession().mask.modelConfig,
        ...{
          model: options.config.model,
        },
      };

      // messages 数组现在直接使用 options.messages，因为预处理已在外部完成
      const messages = options.messages;

      const keys = ["system", "user"];

      // roles must alternate between "user" and "assistant" in claude, so add a fake assistant message between two user messages
      for (let i = 0; i < messages.length - 1; i++) {
        const message = messages[i];
        const nextMessage = messages[i + 1];

        if (keys.includes(message.role) && keys.includes(nextMessage.role)) {
          messages[i] = [
            message,
            {
              role: "assistant",
              content: ";", // 使用分号或其他占位符
            },
          ] as any;
        }
      }

      const prompt = messages
        .flat() // 展平可能存在的嵌套数组
        .filter((v) => {
          // 过滤掉 content 为空或仅包含空白的 message
          if (!v.content) return false;
          if (typeof v.content === "string" && !v.content.trim()) return false;
          if (Array.isArray(v.content) && v.content.length === 0) return false;
          return true;
        })
        .map((v) => {
          const { role, content } = v;
          const insideRole = ClaudeMapper[role] ?? "user";

          // 如果 content 是字符串，或者模型不支持视觉，直接返回文本
          if (typeof content === "string" || !visionModel) {
            return {
              role: insideRole,
              content: typeof content === 'string' ? content : getMessageTextContent(v), // 确保非字符串也转为文本
            };
          }

          // 处理 MultimodalContent[]
          return {
            role: insideRole,
            content: content
              .filter((part) => part.type === "text" || (part.type === "image_url" && part.image_url?.url)) // 确保 URL 存在
              .map((part) => {
                if (part.type === "text") {
                  return {
                    type: "text" as const, // 明确类型
                    text: part.text!,
                  };
                }
                // part.type === "image_url"
                const url = part.image_url!.url; // 此时 URL 应该是 Base64 Data URL

                // 检查是否真的是 Base64 Data URL
                if (url.startsWith("data:")) {
                  const colonIndex = url.indexOf(":");
                  const semicolonIndex = url.indexOf(";");
                  const commaIndex = url.indexOf(",");

                  // 健壮性检查
                  if (colonIndex < 0 || semicolonIndex < 0 || commaIndex < 0 || semicolonIndex <= colonIndex || commaIndex <= semicolonIndex) {
                     console.warn("[Anthropic] Invalid Base64 Data URL format:", url);
                     return { type: "text" as const, text: "[Invalid Image Data]" }; // 返回错误文本
                  }

                  const mimeType = url.slice(colonIndex + 1, semicolonIndex);
                  const encodeType = url.slice(semicolonIndex + 1, commaIndex); // 应该是 'base64'
                  const data = url.slice(commaIndex + 1);

                  if (encodeType !== 'base64' || !data) {
                      console.warn("[Anthropic] Invalid Base64 Data URL encoding or empty data:", url);
                      return { type: "text" as const, text: "[Invalid Image Data]" };
                  }

                  return {
                    type: "image" as const,
                    source: {
                      type: encodeType, // "base64"
                      media_type: mimeType,
                      data,
                    },
                  };
                } else {
                   // 如果 URL 不是 Base64 (可能预处理失败或传入了其他 URL)
                   console.warn("[Anthropic] Expected Base64 Data URL, but got:", url);
                   return { type: "text" as const, text: "[Image Processing Error]" }; // 返回错误文本
                }
              }),
          };
        });

      // Ensure the first message is not from the assistant
      if (prompt[0]?.role === "assistant") {
        prompt.unshift({
          role: "user",
          content: ";", // Use a placeholder like semicolon
        });
      }

      const requestBody: AnthropicChatRequest = {
        messages: prompt,
        stream: shouldStream,
        model: modelConfig.model,
        max_tokens: modelConfig.max_tokens,
        temperature: modelConfig.temperature,
        top_p: modelConfig.top_p,
        top_k: 5, // Anthropic 推荐 top_k
      };

      const path = this.path(Anthropic.ChatPath);
      const controller = new AbortController();
      options.onController?.(controller);

      const headers = {
        ...getHeaders(),
        "anthropic-version": accessStore.anthropicApiVersion,
      };

      if (shouldStream) {
        let index = -1;
        const [tools, funcs] = usePluginStore
          .getState()
          .getAsTools(
            useChatStore.getState().currentSession().mask?.plugin || [],
          );
        return stream(
          path,
          requestBody,
          headers,
          // @ts-ignore - Anthropic tools format
          tools.map((tool) => ({
            name: tool?.function?.name,
            description: tool?.function?.description,
            input_schema: tool?.function?.parameters,
          })),
          funcs,
          controller,
          // parseSSE
          (text: string, runTools: ChatMessageTool[]) => {
            let chunkJson:
              | undefined
              | {
                  type: "content_block_delta" | "content_block_stop" | "message_delta";
                  content_block?: {
                    type: "tool_use";
                    id: string;
                    name: string;
                  };
                  delta?: {
                    type: "text_delta" | "input_json_delta";
                    text?: string;
                    partial_json?: string;
                  };
                  index: number;
                };
            try {
               chunkJson = JSON.parse(text);
            } catch (e) {
               console.error("[Anthropic SSE Parse Error]", text, e);
               return undefined; // Skip invalid JSON
            }

            // Handle tool use start
            if (chunkJson?.type === "content_block_start" && chunkJson?.content_block?.type === "tool_use") {
              index = chunkJson.index; // Store index for potential argument aggregation
              const id = chunkJson.content_block.id;
              const name = chunkJson.content_block.name;
              runTools.push({
                id,
                type: "function", // Assuming 'function' type for internal representation
                function: {
                  name,
                  arguments: "", // Initialize arguments string
                },
              });
            }
            // Handle tool use argument delta
            else if (
              chunkJson?.type === "content_block_delta" &&
              chunkJson?.delta?.type === "input_json_delta" &&
              chunkJson?.delta?.partial_json
            ) {
               // Find the correct tool call by index and append arguments
               const toolIndex = chunkJson.index;
               const targetTool = runTools.find((tool, idx) => idx === toolIndex); // Find by index if reliable, or use ID if needed
               if (targetTool) {
                  targetTool.function!.arguments += chunkJson.delta.partial_json;
               } else {
                  console.warn("[Anthropic] Could not find tool call at index", toolIndex, "to append arguments.");
               }
            }
            // Handle text delta
            else if (chunkJson?.type === "content_block_delta" && chunkJson?.delta?.type === "text_delta") {
               return chunkJson.delta.text;
            }
            // Handle message delta (alternative streaming format)
            else if (chunkJson?.type === "message_delta" && chunkJson?.delta?.type === "text_delta") {
               return chunkJson.delta.text;
            }

            return undefined; // Return undefined if it's not a text delta
          },
          // processToolMessage
          (
            requestPayload: AnthropicChatRequest, // Use specific type
            toolCallMessage: any, // Type based on how runTools is structured
            toolCallResult: any[], // Type based on tool execution result
          ) => {
            index = -1; // Reset index
            // Append assistant's tool use message
            requestPayload.messages.push({
              role: "assistant",
              content: toolCallMessage.tool_calls.map(
                (tool: ChatMessageTool) => ({
                  type: "tool_use",
                  id: tool.id,
                  name: tool.function!.name,
                  input: tool.function!.arguments ? JSON.parse(tool.function!.arguments) : {},
                }),
              ),
            });
            // Append user's tool result messages
            requestPayload.messages.push(...toolCallResult.map((result) => ({
              role: "user", // Role for tool results
              content: [
                {
                  type: "tool_result",
                  tool_use_id: result.tool_call_id, // Use the ID from the original tool call
                  content: result.content, // The result content
                  // is_error: result.isError, // Optional: include error status if available
                },
              ],
            })));
          },
          options,
        );
      } else {
        // Non-streaming request
        const payload = {
          method: "POST",
          body: JSON.stringify(requestBody),
          signal: controller.signal,
          headers: headers,
        };

        try {
          controller.signal.onabort = () =>
            options.onFinish("", new Response(null, { status: 400 }));

          const res = await fetch(path, payload); // Use the global fetch or imported one
          const resJson = await res.json();

          if (resJson.error) {
             console.error("Anthropic API Error:", resJson.error);
             options.onError?.(new Error(resJson.error.message || "Anthropic API error"));
             return;
          }

          const message = this.extractMessage(resJson);
          options.onFinish(message, res);
        } catch (e) {
          console.error("failed to chat", e);
          options.onError?.(e as Error);
        }
      }
    }

  async usage() {
    return {
      used: 0,
      total: 0,
    };
  }
  async models() {
    // const provider = {
    //   id: "anthropic",
    //   providerName: "Anthropic",
    //   providerType: "anthropic",
    // };

    return [
      // {
      //   name: "claude-instant-1.2",
      //   available: true,
      //   provider,
      // },
      // {
      //   name: "claude-2.0",
      //   available: true,
      //   provider,
      // },
      // {
      //   name: "claude-2.1",
      //   available: true,
      //   provider,
      // },
      // {
      //   name: "claude-3-opus-20240229",
      //   available: true,
      //   provider,
      // },
      // {
      //   name: "claude-3-sonnet-20240229",
      //   available: true,
      //   provider,
      // },
      // {
      //   name: "claude-3-haiku-20240307",
      //   available: true,
      //   provider,
      // },
    ];
  }
  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl: string = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.anthropicUrl;
    }

    // if endpoint is empty, use default endpoint
    if (baseUrl.trim().length === 0) {
      const isApp = !!getClientConfig()?.isApp;

      baseUrl = isApp ? ANTHROPIC_BASE_URL : ApiPath.Anthropic;
    }

    if (!baseUrl.startsWith("http") && !baseUrl.startsWith("/api")) {
      baseUrl = "https://" + baseUrl;
    }

    baseUrl = trimEnd(baseUrl, "/");

    // try rebuild url, when using cloudflare ai gateway in client
    return cloudflareAIGatewayUrl(`${baseUrl}/${path}`);
  }
}

function trimEnd(s: string, end = " ") {
  if (end.length === 0) return s;

  while (s.endsWith(end)) {
    s = s.slice(0, -end.length);
  }

  return s;
}
