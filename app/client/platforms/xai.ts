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
import { getTimeoutMSByModel, MultimodalContent, isVisionModel } from "@/app/utils"; // 引入 MultimodalContent, isVisionModel
// import { preProcessImageContent } from "@/app/utils/chat"; // 移除旧的预处理
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
    // const messages: ChatOptions["messages"] = [];
    // for (const v of options.messages) {
    //   const content = await preProcessImageContent(v.content); // 旧的预处理
    //   messages.push({ role: v.role, content });
    // }
    const messages: RequestPayload["messages"] = [];
    // XAI 模型目前主要处理文本，我们假设它还不支持直接的图片或文件输入
    // 因此，我们将提取文本内容，并为非文本内容添加占位符
    // const isVision = isVisionModel(options.config.model); // 检查是否是视觉模型 (XAI 当前无)
    const isVision = false; // 明确假设 XAI 当前模型不支持视觉/文件

    for (const v of options.messages) {
      let processedContent: string | MultimodalContent[]; // 类型保持，但实际只用 string
      if (typeof v.content === 'string') {
        processedContent = v.content;
      } else {
        // 处理 MultimodalContent[]
        const textParts = v.content
          .map(part => {
            if (part.type === 'text') {
              return part.text ?? "";
            } else if (part.type === 'image_url') {
              return "[图片]"; // 为图片添加占位符
            } else if (part.type === 'file_url') {
              // 尝试获取文件名，如果 file_url 或 name 不存在，则使用默认值
              const fileName = part.file_url?.name ?? '未知文件';
              return `[文件: ${fileName}]`; // 为文件添加占位符
            }
            return ""; // 忽略其他未知的 part 类型
          })
          .join("\n"); // 用换行符合并文本和占位符
        processedContent = textParts;
      }
      // 确保 content 最终是字符串
      if (typeof processedContent !== 'string') {
         console.warn("[XAI] Processed content is not a string, converting.", processedContent);
         processedContent = String(processedContent); // 强制转换，虽然理论上不应发生
      }
      messages.push({ role: v.role, content: processedContent });
    }

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
        providerName: options.config.providerName,
      },
    };


    const requestPayload: RequestPayload = {
      messages,
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
