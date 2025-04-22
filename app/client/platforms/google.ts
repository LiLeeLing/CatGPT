import { ApiPath, Google, GEMINI_BASE_URL } from "@/app/constant"; // 合并 GEMINI_BASE_URL
import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  LLMUsage,
  SpeechOptions,
  MultimodalContent, // 确保 MultimodalContent 从 api 导入一次
} from "../api";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
  ChatMessageTool,
} from "@/app/store";
import { stream } from "@/app/utils/chat"; // stream 从 chat 导入
import { getClientConfig } from "@/app/config/client";
import {
  getMessageTextContent, // 从 utils 导入一次
  isVisionModel,         // 从 utils 导入一次
  getTimeoutMSByModel,    // 从 utils 导入一次
} from "@/app/utils";
import { nanoid } from "nanoid"; // 从 nanoid 导入一次
import { fetch } from "@/app/utils/stream"; // fetch 从 stream 导入
import { cacheImageToBase64Image, cacheFileToBase64 } from "@/app/utils/cache"; // 从 cache 导入一次

// 定义 Google API 的消息和部分结构类型 (保持不变)
type GoogleApiMessagePart = {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string; // Base64 encoded data
  };
  functionCall?: any; // 根据 API 定义
  functionResponse?: any; // 根据 API 定义
  // fileData?: { mimeType: string; fileUri: string; };
};

type GoogleApiMessage = {
  role: "user" | "model" | "function"; // Google API 的角色
  parts: GoogleApiMessagePart[];
};

type GoogleApiRequestPayload = {
  contents: GoogleApiMessage[];
  generationConfig: {
    temperature: number;
    maxOutputTokens?: number;
    topP: number;
    // topK?: number;
  };
  safetySettings: Array<{ category: string; threshold: string }>;
  tools?: any[]; // 根据 API 定义
};

export class GeminiProApi implements LLMApi {
  path(path: string, shouldStream = false): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";
    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.googleUrl;
    }

    const isApp = !!getClientConfig()?.isApp;
    if (baseUrl.length === 0) {
      baseUrl = isApp ? GEMINI_BASE_URL : ApiPath.Google;
    }
    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.Google)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    let chatPath = [baseUrl, path].join("/");
    if (shouldStream) {
      chatPath += chatPath.includes("?") ? "&alt=sse" : "?alt=sse";
    }

    return chatPath;
  }
  extractMessage(res: any) {
    console.log("[Response] gemini-pro response: ", res);

    const getTextFromParts = (parts: any[]) => {
      if (!Array.isArray(parts)) return "";

      return parts
        .map((part) => part?.text || "")
        .filter((text) => text.trim() !== "")
        .join("\n\n"); // 使用换行符合并文本部分
    };

    let content = "";
    // 处理可能的流式响应数组
    if (Array.isArray(res)) {
      res.forEach((item) => { // 使用 forEach 替代 map
        content += getTextFromParts(item?.candidates?.at(0)?.content?.parts);
      });
    } else {
       // 处理非数组响应
       content = getTextFromParts(res?.candidates?.at(0)?.content?.parts);
    }

    // 如果 content 仍然为空，检查错误消息
    if (!content && res?.error?.message) {
       content = `Error: ${res.error.message}`;
    }

    return content || ""; // 返回提取的文本或空字符串
  }
  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  async chat(options: ChatOptions): Promise<void> {
    const apiClient = this;
    const accessStore = useAccessStore.getState();
    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
      },
    };
    const visionModel = isVisionModel(options.config.model); // 检查模型是否支持视觉/文件

    // 1. Process messages into Google API format
    const messages: GoogleApiMessage[] = []; // 使用 GoogleApiMessage 类型
    for (const v of options.messages) {
      // 角色转换: assistant -> model, system -> user (如果 system 是第一个消息)
      // Google 要求 user 和 model 交替，且不能以 model 开始
      const role = v.role === "assistant" ? "model" : "user";
      let parts: GoogleApiMessagePart[] = []; // 使用 GoogleApiMessagePart 类型

      if (typeof v.content === 'string') {
        // 处理纯文本
        parts.push({ text: v.content });
      } else {
        // 处理 MultimodalContent[]
        for (const part of v.content) {
          if (part.type === 'text') {
            parts.push({ text: part.text ?? "" });
          } else if (part.type === 'image_url' && visionModel && part.image_url?.url) {
            try {
              // 图片处理：获取 Base64
              const base64DataUrl = await cacheImageToBase64Image(part.image_url.url); // 使用缓存和压缩函数
              const mimeMatch = base64DataUrl.match(/data:(.*?);base64,/);
              const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg'; // 默认或提取 MIME
              const base64Data = base64DataUrl.split(',')[1];
              if (base64Data) {
                parts.push({
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Data,
                  },
                });
              } else {
                 console.warn("[Google] Empty base64 data for image:", part.image_url.url);
                 parts.push({ text: `[图片处理失败: ${part.image_url.url}]` });
              }
            } catch (e) {
              console.error("[Google] Failed to process image:", e);
              parts.push({ text: `[图片处理错误: ${part.image_url.url}]` });
            }
          } else if (part.type === 'file_url' && visionModel && part.file_url?.url) {
            // 文件处理：获取 Base64
            // 参考: https://ai.google.dev/gemini-api/docs/prompting_with_media#supported_file_formats
            const supportedMimeTypes = [
              "image/", "audio/", "video/", "application/pdf", "text/plain", "text/csv",
              "text/html", "text/css", "application/json", "text/markdown",
              "text/x-python", "text/x-c", "text/x-c++", "application/rtf",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
              "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
              // 根据需要添加更多文本或代码类型
            ];
            const mimeType = part.file_url.mimeType || 'application/octet-stream';
            const isSupported = supportedMimeTypes.some(type =>
              mimeType.startsWith(type) || type === mimeType
            );

            if (isSupported) {
              try {
                // --- 修改开始：使用 cacheFileToBase64 ---
                // const response = await fetch(part.file_url.url); // Use the imported fetch
                // if (!response.ok) throw new Error(`Failed to fetch file: ${response.statusText}`);
                // const blob = await response.blob();
                // const reader = new FileReader();
                // const base64Data = await new Promise<string>((resolve, reject) => {
                //   reader.onloadend = () => {
                //     const result = reader.result as string;
                //     if (result) {
                //       resolve(result.split(',')[1]);
                //     } else {
                //       reject(new Error("FileReader returned null result"));
                //     }
                //   };
                //   reader.onerror = reject;
                //   reader.readAsDataURL(blob);
                // });
                const base64Data = await cacheFileToBase64(part.file_url.url); // 使用缓存函数
                // --- 修改结束 ---

                if (base64Data) {
                  parts.push({
                    inline_data: {
                      mime_type: mimeType, // 使用 part 中提供的 MIME 类型
                      data: base64Data,
                    },
                  });
                } else {
                   const fileName = part.file_url.name ?? '未知文件';
                   console.warn("[Google] Empty base64 data for file:", fileName);
                   parts.push({ text: `[文件处理失败: ${fileName}]` });
                }
              } catch (e) {
                const fileName = part.file_url.name ?? '未知文件';
                console.error("[Google] Failed to process file:", e);
                parts.push({ text: `[文件处理错误: ${fileName}]` });
              }
            } else {
              // File type not supported by inline_data
              const fileName = part.file_url.name ?? '未知文件';
              console.warn(`File type ${mimeType} not directly supported by Gemini inline_data. Sending placeholder.`);
              parts.push({ text: `[文件: ${fileName} (${mimeType})]` });
            }
          } else if ((part.type === "image_url" || part.type === "file_url") && !visionModel) {
             // 非视觉模型，添加占位符
             const fileName = part.type === "image_url" ? "图片" : part.file_url?.name ?? "文件";
             parts.push({ text: `[${fileName} (当前模型不支持)]` });
          }
        }
      }

      // 过滤掉空的文本部分，并确保 parts 不为空
      parts = parts.filter(p => !(p.text !== undefined && p.text.trim() === ""));
      if (parts.length === 0) {
        console.warn("[Google] Message content resulted in empty parts array, adding placeholder.");
        parts.push({ text: "[空消息]" });
      }

      // 角色合并逻辑将在下一步处理
      messages.push({ role: role as "user" | "model", parts }); // 断言角色类型
    }

    // 2. Google 要求 user 和 model 角色交替，且不能以 model 开始
    const finalMessages: GoogleApiMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      const currentMsg = messages[i];
      // 处理 system prompt (Gemini 没有 system 角色，通常合并到第一个 user 消息)
      // 注意：原始消息数组 options.messages 用于判断原始角色
      if (currentMsg.role === "user" && options.messages[i]?.role === "system") {
         // 如果原始角色是 system，尝试合并到上一个 user 消息或作为第一个 user 消息的一部分
         const lastFinalMsg = finalMessages[finalMessages.length - 1];
         if (lastFinalMsg && lastFinalMsg.role === "user") {
            // 合并 system prompt 到上一个 user 消息的开头
            lastFinalMsg.parts = currentMsg.parts.concat(lastFinalMsg.parts);
            continue; // 跳过添加新的 user 消息
         }
         // 否则，它将作为第一个 user 消息（或合并后的 user 消息）
      }

      const lastFinalMsg = finalMessages[finalMessages.length - 1];
      if (lastFinalMsg && lastFinalMsg.role === currentMsg.role) {
        // 合并相同角色的 parts
        lastFinalMsg.parts = lastFinalMsg.parts.concat(currentMsg.parts);
      } else {
        finalMessages.push(currentMsg);
      }
    }
    // 确保第一个消息不是 model
    if (finalMessages.length > 0 && finalMessages[0].role === "model") {
       // 如果第一个是 model，尝试查找后续的 user 消息并提前
       const firstUserIndex = finalMessages.findIndex(m => m.role === 'user');
       if (firstUserIndex > 0) {
          const firstUserMsg = finalMessages.splice(firstUserIndex, 1)[0];
          finalMessages.unshift(firstUserMsg);
       } else {
          // 如果没有 user 消息，添加虚拟 user 消息 (这通常不应该发生)
          finalMessages.unshift({ role: "user", parts: [{ text: "..." }] });
       }
    }
    // 确保最后一个消息是 user (如果需要调用 function calling，Gemini API 要求)
    const [tools] = usePluginStore.getState().getAsTools(
       useChatStore.getState().currentSession().mask?.plugin || [],
    );
    if (tools.length > 0 && finalMessages.length > 0 && finalMessages[finalMessages.length - 1]?.role !== "user") {
       // 如果最后一个不是 user，添加一个空的 user 消息以满足 API 要求
       finalMessages.push({ role: "user", parts: [{ text: "" }] }); // 空文本即可
    }


    // 3. Construct Request Payload
    const [, funcs] = usePluginStore
      .getState()
      .getAsTools(
        useChatStore.getState().currentSession().mask?.plugin || [],
      );

    const requestPayload: GoogleApiRequestPayload = {
      contents: finalMessages, // 使用处理和合并后的消息
      generationConfig: {
        temperature: modelConfig.temperature,
        maxOutputTokens: modelConfig.max_tokens || undefined, // 确保是 number 或 undefined
        topP: modelConfig.top_p,
      },
      safetySettings: [ // 安全设置保持不变
        { category: "HARM_CATEGORY_HARASSMENT", threshold: accessStore.googleSafetySettings },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: accessStore.googleSafetySettings },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: accessStore.googleSafetySettings },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: accessStore.googleSafetySettings },
      ],
      // 添加 tools 配置 (如果 Gemini API 支持)
      // 参考: https://ai.google.dev/gemini-api/docs/function-calling
      tools: tools.length > 0 ? [{ functionDeclarations: tools.map((tool: any) => tool.function) }] : undefined,
    };


    // 4. Make API Call (Streaming or Non-streaming)
    let shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const chatPath = this.path(
        Google.ChatPath(modelConfig.model),
        shouldStream,
      );

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
        // Pass the modified requestPayload to the stream function
        return stream(
          chatPath,
          requestPayload, // Pass the correctly structured payload
          getHeaders(),
          // @ts-ignore
          tools.length > 0
            ? // @ts-ignore
              [{ functionDeclarations: tools.map((tool) => tool.function) }]
            : [],
          funcs,
          controller,
          // parseSSE
          (text: string, runTools: ChatMessageTool[]) => {
            try {
                // Gemini streaming responses might be chunked JSON arrays.
                // We need to handle potentially incomplete JSON fragments.
                // A simple approach for now: try parsing, log errors.
                // More robust: buffer and parse when complete.
                const chunkJson = JSON.parse(text);

                const functionCall = chunkJson?.candidates
                  ?.at(0)
                  ?.content.parts.at(0)?.functionCall;
                if (functionCall) {
                  const { name, args } = functionCall;
                  runTools.push({
                    id: nanoid(),
                    type: "function",
                    function: {
                      name,
                      arguments: JSON.stringify(args), // utils.chat call function, using JSON.parse
                    },
                  });
                }
                // Extract text content, handling potential arrays in response
                let chunkText = "";
                if (Array.isArray(chunkJson)) {
                   chunkJson.forEach(item => {
                      chunkText += item?.candidates?.at(0)?.content?.parts?.map((part: { text: string }) => part.text).join("") ?? "";
                   });
                } else {
                   chunkText = chunkJson?.candidates?.at(0)?.content?.parts?.map((part: { text: string }) => part.text).join("") ?? "";
                }
                return chunkText;

            } catch (e) {
                console.error("[SSE Parse Error]", text, e);
                return ""; // Return empty string on parse error
            }
          },
          // processToolMessage, include tool_calls message and tool call results
          (
            reqPayload: any, // Use 'any' or a more specific type if stream modifies it
            toolCallMessage: any,
            toolCallResult: any[],
          ) => {
            // Modify the 'contents' array within the request payload
            reqPayload?.contents?.splice(
              reqPayload?.contents?.length,
              0,
              {
                role: "model", // Gemini expects 'model' role for function calls
                parts: toolCallMessage.tool_calls.map(
                  (tool: ChatMessageTool) => ({
                    functionCall: {
                      name: tool?.function?.name,
                      args: JSON.parse(tool?.function?.arguments as string),
                    },
                  }),
                ),
              },
              // Gemini expects 'function' role for results
              ...toolCallResult.map((result) => ({
                role: "function", // Use 'function' role for results
                parts: [
                  {
                    functionResponse: {
                      name: result.name,
                      response: {
                        // Structure might vary based on Gemini's exact expectation
                        name: result.name,
                        content: result.content,
                      },
                    },
                  },
                ],
              })),
            );
          },
          options,
        );
      } else {
        // Non-streaming request
        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);
        const resJson = await res.json();
        if (resJson?.promptFeedback?.blockReason) {
          // being blocked
          options.onError?.(
            new Error(
              "Message is being blocked for reason: " +
                resJson.promptFeedback.blockReason,
            ),
          );
        }
        const message = apiClient.extractMessage(resJson);
        options.onFinish(message, res);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }

  usage(): Promise<LLMUsage> {
    throw new Error("Method not implemented.");
  }
  async models(): Promise<LLMModel[]> {
    return [];
  }
}
