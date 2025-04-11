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

    async chat(options: ChatOptions) {
      // --- 开始: 通用修改逻辑 (适配 Moonshot) ---
      const processedMessages: ChatOptions["messages"] = [];
      for (const v of options.messages) {
        let processedContent: string | MultimodalContent[];
        const modelConfig = { ...useAppConfig.getState().modelConfig, ...useChatStore.getState().currentSession().mask.modelConfig, ...{ model: options.config.model } };
        const visionModel = isVisionModel(modelConfig.model); // Moonshot 可能没有 vision 模型

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
              // Moonshot API 格式未知，暂时忽略图片
              // if (visionModel) { tempContent.push(part); }
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
            // Moonshot API 可能只接受字符串
            processedContent = filteredContent.map(p => p.text ?? "").join("\n"); // 强制转字符串
          } else {
            processedContent = getMessageTextContent(v);
          }

           if (v.role === "assistant" && typeof getMessageTextContentWithoutThinking === 'function') {
               if (typeof processedContent === 'string') {
                   processedContent = getMessageTextContentWithoutThinking({ role: v.role, content: processedContent });
               } // 数组情况已处理为字符串
           }
        }

        const content = processedContent;
        // 确保 content 是字符串
        processedMessages.push({ role: v.role, content: typeof content === 'string' ? content : getMessageTextContent(v) });
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

      const requestPayload: RequestPayload = {
        messages: processedMessages, // 使用处理后的 messages
        stream: options.config.stream,
        model: modelConfig.model,
  
      temperature: modelConfig.temperature,
      presence_penalty: modelConfig.presence_penalty,
      frequency_penalty: modelConfig.frequency_penalty,
      top_p: modelConfig.top_p,
      // max_tokens: Math.max(modelConfig.max_tokens, 1024),
      // Please do not ask me why not send max_tokens, no reason, this param is just shit, I dont want to explain anymore.
    };

    console.log("[Request] openai payload: ", requestPayload);

    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const chatPath = this.path(Moonshot.ChatPath);
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      if (shouldStream) {
        const [tools, funcs] = usePluginStore
          .getState()
          .getAsTools(
            useChatStore.getState().currentSession().mask?.plugin || [],
          );
        return stream(
          chatPath,
          requestPayload,
          getHeaders(),
          tools as any,
          funcs,
          controller,
          // parseSSE
          (text: string, runTools: ChatMessageTool[]) => {
            // console.log("parseSSE", text, runTools);
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
          // processToolMessage, include tool_calls message and tool call results
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
        const res = await fetch(chatPath, chatPayload);
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
