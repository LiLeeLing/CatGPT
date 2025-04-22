"use client";
// azure and openai, using same models. so using same LLMApi.
import {
  ApiPath,
  MOONSHOT_BASE_URL,
  Moonshot,
  REQUEST_TIMEOUT_MS,
} from "@/app/constant";
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
import { getMessageTextContent } from "@/app/utils";
import { RequestPayload } from "./openai";
import { fetch } from "@/app/utils/stream";

export class MoonshotApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.moonshotUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = ApiPath.Moonshot;
      baseUrl = isApp ? MOONSHOT_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.Moonshot)) {
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
      // Moonshot (Kimi) 当前似乎只处理文本，保持现有逻辑
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

      // 假设 Moonshot API 结构类似 OpenAI
      const requestPayload: RequestPayload = {
        messages,
        stream: options.config.stream,
        model: modelConfig.model,
        temperature: modelConfig.temperature,
        // presence_penalty: modelConfig.presence_penalty, // 确认支持
        // frequency_penalty: modelConfig.frequency_penalty, // 确认支持
        top_p: modelConfig.top_p, // 确认支持
        // max_tokens: modelConfig.max_tokens, // 确认支持
      };

      console.log("[Request] Moonshot payload: ", requestPayload); // 更新日志名称

      const shouldStream = !!options.config.stream;
      const controller = new AbortController();
      options.onController?.(controller);

      try {
        const chatPath = this.path(Moonshot.ChatPath); // 确认路径
        const chatPayload = {
          method: "POST",
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
          headers: getHeaders(), // 可能需要特定的认证头
        };

        // make a fetch request
        const requestTimeoutId = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS, // 使用默认超时或根据模型调整
        );

        if (shouldStream) {
          const [tools, funcs] = usePluginStore
            .getState()
            .getAsTools(
              useChatStore.getState().currentSession().mask?.plugin || [],
            );
          // 假设 Moonshot API 结构类似 OpenAI，使用 stream
          return stream(
            chatPath,
            requestPayload,
            getHeaders(),
            tools as any, // TODO: 确认 Moonshot API 的 tools 格式
            funcs,
            controller,
            // parseSSE - 假设类似 OpenAI
            (text: string, runTools: ChatMessageTool[]) => {
              let json;
              try {
                 json = JSON.parse(text);
              } catch (e) {
                 console.error("[Moonshot SSE Parse Error]", text, e);
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

          // TODO: 确认 Moonshot API 的错误格式
          if (resJson.error) {
             console.error("Moonshot API Error:", resJson.error);
             options.onError?.(new Error(resJson.error.message || "Moonshot API error"));
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
