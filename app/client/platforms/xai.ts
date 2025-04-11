"use client";
// azure and openai, using same models. so using same LLMApi.
import { ApiPath, XAI_BASE_URL, XAI } from "@/app/constant";
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
import { getTimeoutMSByModel } from "@/app/utils";
import { preProcessImageContent } from "@/app/utils/chat";
import { RequestPayload } from "./openai";
import { fetch } from "@/app/utils/stream";

export class XAIApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.xaiUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = ApiPath.XAI;
      baseUrl = isApp ? XAI_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.XAI)) {
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
    // --- 开始: 通用修改逻辑 (适配 XAI) ---
    const processedMessages: ChatOptions["messages"] = [];
    for (const v of options.messages) {
      let processedContent: string | MultimodalContent[];
      const modelConfig = { ...useAppConfig.getState().modelConfig, ...useChatStore.getState().currentSession().mask.modelConfig, ...{ model: options.config.model } };
      const visionModel = isVisionModel(modelConfig.model); // XAI 可能有 vision 模型

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
               // XAI API 格式未知，暂时使用 OpenAI 格式
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
          // XAI API 可能接受数组
          processedContent = filteredContent;
        } else {
          processedContent = getMessageTextContent(v);
        }

         if (v.role === "assistant" && typeof getMessageTextContentWithoutThinking === 'function') {
             if (typeof processedContent === 'string') {
                 processedContent = getMessageTextContentWithoutThinking({ role: v.role, content: processedContent });
             } else if (Array.isArray(processedContent)) {
                 // 数组情况下的 thinking 处理
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

    const requestPayload: RequestPayload = {
      messages: processedMessages, // 使用处理后的 messages
      stream: options.config.stream,
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      presence_penalty: modelConfig.presence_penalty,
      frequency_penalty: modelConfig.frequency_penalty,
      top_p: modelConfig.top_p,
    };

    console.log("[Request] xai payload: ", requestPayload);

    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const chatPath = this.path(XAI.ChatPath);
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
