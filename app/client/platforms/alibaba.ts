"use client";
import { ApiPath, Alibaba, ALIBABA_BASE_URL } from "@/app/constant";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
  ChatMessageTool,
  usePluginStore,
} from "@/app/store";
import {
  preProcessImageContentForAlibabaDashScope,
  streamWithThink,
} from "@/app/utils/chat";
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

    const messages: ChatOptions["messages"] = [];
    for (const v of options.messages) {
      const content = (
        visionModel
          ? await preProcessImageContentForAlibabaDashScope(v.content)
          : v.role === "assistant"
  let processedContent: string | MultimodalContentForAlibaba[]; // 使用 Qwen 的特定类型

  if (typeof v.content === 'string') {
    // 如果是字符串，根据角色处理
    processedContent = v.role === "assistant"
      ? getMessageTextContentWithoutThinking(v) // 假设这个函数能处理字符串
      : v.content;
  } else {
    // 如果是数组
    const tempContent: MultimodalContentForAlibaba[] = [];
    let fileText = ""; // 用于收集文件提示

    for (const part of v.content) {
      if (part.type === 'text') {
        // Qwen API 期望 { text: "..." }
        tempContent.push({ text: part.text ?? "" });
      } else if (part.type === 'image_url') {
        if (visionModel) {
          // Qwen API 期望 { image: "data:..." } 或 { url: "oss://..." }
          // 假设 preProcessImageContentForAlibabaDashScope 返回这种格式
          // 这里需要调整，因为 preProcessImageContentForAlibabaDashScope 可能期望整个 content
          // 简化：假设 image_url.url 已经是 Qwen 接受的格式 (可能是 base64 data url)
          tempContent.push({ image: part.image_url?.url }); // 需要确认 Qwen API 格式
        } else {
          // 非 Vision 模型，忽略图片
        }
      } else if (part.type === 'file_url' && part.file_url) {
        // 收集文件提示文本
        fileText += (fileText ? "\n" : "") + `[File attached: ${part.file_url.name}]`;
      }
    }

    // 如果有文件提示，附加到最后一个文本部分或新增一个文本部分
    if (fileText) {
      const lastTextPart = tempContent.slice().reverse().find(p => p.text !== undefined);
      if (lastTextPart) {
        lastTextPart.text = (lastTextPart.text ?? "") + "\n" + fileText;
      } else {
        tempContent.push({ text: fileText });
      }
    }

    // 过滤掉空的文本部分
    const filteredContent = tempContent.filter(p => !(p.text !== undefined && p.text.trim() === ""));

    // 简化：如果处理后只剩下文本，则合并为字符串
    if (filteredContent.every(p => p.text !== undefined && p.image === undefined)) {
      processedContent = filteredContent.map(p => p.text ?? "").join("\n");
    } else if (filteredContent.length > 0) {
      processedContent = filteredContent;
    } else {
      // 如果过滤后为空，尝试获取原始文本
      processedContent = getMessageTextContent(v);
    }

    // 对助手的响应应用 getMessageTextContentWithoutThinking
    if (v.role === "assistant" && typeof processedContent === 'string') {
       processedContent = getMessageTextContentWithoutThinking({ role: v.role, content: processedContent });
    } else if (v.role === "assistant" && Array.isArray(processedContent)) {
       // 如果助手响应是数组，可能需要更复杂的处理来移除 "thinking" 部分
       // 暂时只处理文本部分
       processedContent.forEach(part => {
          if (part.text) {
             part.text = getMessageTextContentWithoutThinking({ role: v.role, content: part.text });
          }
       });
       // 过滤掉处理后可能变空的文本部分
       processedContent = processedContent.filter(p => !(p.text !== undefined && p.text.trim() === ""));
       // 如果过滤后只剩一个文本部分，简化为字符串
       if (processedContent.length === 1 && processedContent[0].text !== undefined) {
          processedContent = processedContent[0].text;
       } else if (processedContent.length === 0) {
          processedContent = ""; // 如果全空了
       }
    }
  }

  // 确保 preProcessImageContentForAlibabaDashScope 在这里不再需要或已调整
  const content = processedContent as any; // 类型断言，因为 Qwen API 类型不同

  messages.push({ role: v.role, content });
}

const shouldStream = !!options.config.stream;

          const requestPayload: RequestPayload = {
      model: modelConfig.model,
      input: {
        messages,
      },
      parameters: {
        result_format: "message",
        incremental_output: shouldStream,
        temperature: modelConfig.temperature,
        // max_tokens: modelConfig.max_tokens,
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
            // console.log("parseSSE", text, runTools);
            const json = JSON.parse(text);
            const choices = json.output.choices as Array<{
              message: {
                content: string | null | MultimodalContentForAlibaba[];
                tool_calls: ChatMessageTool[];
                reasoning_content: string | null;
              };
            }>;

            if (!choices?.length) return { isThinking: false, content: "" };

            const tool_calls = choices[0]?.message?.tool_calls;
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

            const reasoning = choices[0]?.message?.reasoning_content;
            const content = choices[0]?.message?.content;

            // Skip if both content and reasoning_content are empty or null
            if (
              (!reasoning || reasoning.length === 0) &&
              (!content || content.length === 0)
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
            } else if (content && content.length > 0) {
              return {
                isThinking: false,
                content: Array.isArray(content)
                  ? content.map((item) => item.text).join(",")
                  : content,
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
            requestPayload?.input?.messages?.splice(
              requestPayload?.input?.messages?.length,
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
export { Alibaba };
