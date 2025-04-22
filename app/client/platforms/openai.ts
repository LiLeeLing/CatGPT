"use client";
// azure and openai, using same models. so using same LLMApi.
import {
  ApiPath,
  OPENAI_BASE_URL,
  DEFAULT_MODELS,
  OpenaiPath,
  Azure,
  REQUEST_TIMEOUT_MS,
  ServiceProvider,
} from "@/app/constant";
import {
  ChatMessageTool,
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
} from "@/app/store";
import { collectModelsWithDefaultModel } from "@/app/utils/model";
import {
  preProcessMultimodalContent,
  uploadImage,
  base64Image2Blob,
  streamWithThink,
} from "@/app/utils/chat";
import { cloudflareAIGatewayUrl } from "@/app/utils/cloudflare";
import { ModelSize, DalleQuality, DalleStyle } from "@/app/typing";

import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  LLMUsage,
  MultimodalContent,
  SpeechOptions,
} from "../api";
import Locale from "../../locales";
import { getClientConfig } from "@/app/config/client";
import {
  getMessageTextContent,
  isVisionModel,
  isDalle3 as _isDalle3,
  getTimeoutMSByModel,
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

export interface RequestPayload {
  messages: {
    role: "system" | "user" | "assistant";
    content: string | MultimodalContent[];
  }[];
  stream?: boolean;
  model: string;
  temperature: number;
  presence_penalty: number;
  frequency_penalty: number;
  top_p: number;
  max_tokens?: number;
  max_completion_tokens?: number;
}

export interface DalleRequestPayload {
  model: string;
  prompt: string;
  response_format: "url" | "b64_json";
  n: number;
  size: ModelSize;
  quality: DalleQuality;
  style: DalleStyle;
}

export class ChatGPTApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    const isAzure = path.includes("deployments");
    if (accessStore.useCustomConfig) {
      if (isAzure && !accessStore.isValidAzure()) {
        throw Error(
          "incomplete azure config, please check it in your settings page",
        );
      }

      baseUrl = isAzure ? accessStore.azureUrl : accessStore.openaiUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = isAzure ? ApiPath.Azure : ApiPath.OpenAI;
      baseUrl = isApp ? OPENAI_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (
      !baseUrl.startsWith("http") &&
      !isAzure &&
      !baseUrl.startsWith(ApiPath.OpenAI)
    ) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    // try rebuild url, when using cloudflare ai gateway in client
    return cloudflareAIGatewayUrl([baseUrl, path].join("/"));
  }

  async extractMessage(res: any) {
    if (res.error) {
      return "```\n" + JSON.stringify(res, null, 4) + "\n```";
    }
    // dalle3 model return url, using url create image message
    if (res.data) {
      let url = res.data?.at(0)?.url ?? "";
      const b64_json = res.data?.at(0)?.b64_json ?? "";
      if (!url && b64_json) {
        // uploadImage
        url = await uploadImage(base64Image2Blob(b64_json, "image/png"));
      }
      return [
        {
          type: "image_url",
          image_url: {
            url,
          },
        },
      ];
    }
    return res.choices?.at(0)?.message?.content ?? res;
  }

  async speech(options: SpeechOptions): Promise<ArrayBuffer> {
    const requestPayload = {
      model: options.model,
      input: options.input,
      voice: options.voice,
      response_format: options.response_format,
      speed: options.speed,
    };

    console.log("[Request] openai speech payload: ", requestPayload);

    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const speechPath = this.path(OpenaiPath.SpeechPath);
      const speechPayload = {
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

      const res = await fetch(speechPath, speechPayload);
      clearTimeout(requestTimeoutId);
      return await res.arrayBuffer();
    } catch (e) {
      console.log("[Request] failed to make a speech request", e);
      throw e;
    }
  }

    async chat(options: ChatOptions) {
      const modelConfig = {
        ...useAppConfig.getState().modelConfig,
        ...useChatStore.getState().currentSession().mask.modelConfig,
        ...{
          model: options.config.model,
          providerName: options.config.providerName,
        },
      };

      let requestPayload: RequestPayload | DalleRequestPayload;

      const isDalle3 = _isDalle3(options.config.model);
      const isO1OrO3 =
        options.config.model.startsWith("o1") ||
        options.config.model.startsWith("o3");

      if (isDalle3) {
        // DALL-E 3 logic remains the same, extracting the last text prompt
        const prompt = getMessageTextContent(
          options.messages.slice(-1)?.pop() as any, // Get last message text
        );
        requestPayload = {
          model: options.config.model,
          prompt,
          response_format: "b64_json", // Use b64_json for caching
          n: 1,
          size: options.config?.size ?? "1024x1024",
          quality: options.config?.quality ?? "standard",
          style: options.config?.style ?? "vivid",
        };
      } else {
        // Logic for chat models (including vision)
        const visionModel = isVisionModel(options.config.model);
        const messages: ChatOptions["messages"] = [];

        for (const v of options.messages) {
          // The content received here should already be pre-processed (Base64 for images)
          // by preProcessMultimodalContent called externally (e.g., in store/chat.ts)
          let processedContent = v.content; // Assume content is already pre-processed

          // If the model supports vision and content is an array (potentially multimodal)
          if (visionModel && Array.isArray(processedContent)) {
            const finalContentParts: MultimodalContent[] = [];
            for (const part of processedContent) {
              if (part.type === 'text') {
                finalContentParts.push(part);
              } else if (part.type === 'image_url' && part.image_url?.url) {
                const url = part.image_url.url;
                if (url.startsWith('data:')) {
                  // It's a Base64 Data URL, needs re-upload for OpenAI
                  try {
                    const mimeMatch = url.match(/data:(.*?);base64,/);
                    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png'; // Default MIME type
                    const base64Data = url.split(',')[1];
                    if (!base64Data) throw new Error("Empty base64 data");

                    const blob = base64Image2Blob(base64Data, mimeType);
                    // Call uploadImage to get a public URL (ensure uploadImage provides this)
                    const publicUrl = await uploadImage(blob);
                    finalContentParts.push({
                      type: 'image_url',
                      image_url: { url: publicUrl } // Use the public URL
                    });
                  } catch (error) {
                    console.error("[OpenAI] Error re-uploading image:", error);
                    finalContentParts.push({ type: 'text', text: '[Image Upload Error]' });
                  }
                } else {
                  // If it's not Base64, assume it's already a usable public URL
                  finalContentParts.push(part);
                }
              }
              // TODO: Handle file_url if OpenAI supports it and requires public URLs
              // Similar logic: check if URL is cache URL, if so, re-upload to get public URL
            }
            // Filter out system messages for O1/O3 models
            if (!(isO1OrO3 && v.role === "system")) {
              messages.push({ role: v.role, content: finalContentParts });
            }
          } else {
            // If not a vision model or content is just a string, get text content
            const textContent = getMessageTextContent(v);
            // Filter out system messages for O1/O3 models
            if (!(isO1OrO3 && v.role === "system")) {
              messages.push({ role: v.role, content: textContent });
            }
          }
        }

        // Construct the payload for chat models
        requestPayload = {
          messages: messages as any, // Assert type after processing
          stream: options.config.stream,
          model: modelConfig.model,
          temperature: !isO1OrO3 ? modelConfig.temperature : 1,
          presence_penalty: !isO1OrO3 ? modelConfig.presence_penalty : 0,
          frequency_penalty: !isO1OrO3 ? modelConfig.frequency_penalty : 0,
          top_p: !isO1OrO3 ? modelConfig.top_p : 1,
        };

        // Use max_completion_tokens for O1/O3, max_tokens for others (especially vision)
        if (isO1OrO3) {
          requestPayload["max_completion_tokens"] = modelConfig.max_tokens;
        } else if (visionModel) {
          // Add max_tokens specifically for vision models if needed, OpenAI default is usually sufficient
           requestPayload["max_tokens"] = Math.max(modelConfig.max_tokens, 4000); // Example: ensure at least 4000 for vision
        } else {
           // For regular chat models, max_tokens is often optional unless specific control is needed
           // requestPayload["max_tokens"] = modelConfig.max_tokens;
        }
      }

      console.log("[Request] openai payload: ", requestPayload);

      const shouldStream = !isDalle3 && !!options.config.stream;
      const controller = new AbortController();
      options.onController?.(controller);

      try {
        let chatPath = "";
        // Determine the correct API path (Azure or OpenAI)
        if (modelConfig.providerName === ServiceProvider.Azure) {
          const { models: configModels, customModels: configCustomModels } =
            useAppConfig.getState();
          const {
            defaultModel,
            customModels: accessCustomModels,
            useCustomConfig,
            azureApiVersion, // Get Azure API version from access store
          } = useAccessStore.getState();
          const models = collectModelsWithDefaultModel(
            configModels,
            [configCustomModels, accessCustomModels].join(","),
            defaultModel,
          );
          const modelInfo = models.find(
            (m) =>
              m.name === modelConfig.model &&
              m?.provider?.providerName === ServiceProvider.Azure,
          );
          const deploymentName = modelInfo?.displayName ?? modelInfo?.name; // Use displayName as deployment name if available
          if (!deploymentName) {
             throw new Error(`Deployment name not found for Azure model: ${modelConfig.model}`);
          }
          const apiVersionToUse = useCustomConfig ? azureApiVersion : "2023-08-01-preview"; // Use configured or default version
          chatPath = this.path(
            (isDalle3 ? Azure.ImagePath : Azure.ChatPath)(
              deploymentName,
              apiVersionToUse,
            ),
          );
        } else {
          // OpenAI path
          chatPath = this.path(
            isDalle3 ? OpenaiPath.ImagePath : OpenaiPath.ChatPath,
          );
        }

        // Handle streaming or non-streaming request
        if (shouldStream) {
          let index = -1;
          const [tools, funcs] = usePluginStore
            .getState()
            .getAsTools(
              useChatStore.getState().currentSession().mask?.plugin || [],
            );
          streamWithThink(
            chatPath,
            requestPayload, // Pass the correct payload type (RequestPayload)
            getHeaders(),
            tools as any, // Cast tools if necessary, ensure format matches API
            funcs,
            controller,
            // parseSSE - Handles OpenAI's SSE format
            (text: string, runTools: ChatMessageTool[]) => {
              let json;
              try {
                 json = JSON.parse(text);
              } catch (e) {
                 console.error("[OpenAI SSE Parse Error]", text, e);
                 return { isThinking: false, content: "" };
              }

              const choices = json.choices as Array<{
                delta: {
                  content: string | null;
                  tool_calls?: ChatMessageTool[];
                  // reasoning_content?: string | null; // OpenAI doesn't typically send this
                };
              }>;

              if (!choices?.length) return { isThinking: false, content: "" };

              const delta = choices[0]?.delta;
              const tool_calls = delta?.tool_calls;
              // const reasoning = delta?.reasoning_content;
              const content = delta?.content;

              if (tool_calls?.length > 0) {
                // Handle tool call aggregation
                const tool = tool_calls[0];
                const toolIndex = tool.index; // OpenAI uses index for aggregation
                const id = tool.id;
                const args = tool.function?.arguments;
                if (id && toolIndex !== undefined) { // Start of a new tool call
                   // Ensure index is within bounds or push new
                   if (toolIndex >= runTools.length) {
                      runTools.push({
                        id,
                        type: tool.type,
                        function: { name: tool.function!.name, arguments: args || "" },
                      });
                   } else {
                      // Replace if index exists (shouldn't happen for start?)
                      runTools[toolIndex] = {
                        id,
                        type: tool.type,
                        function: { name: tool.function!.name, arguments: args || "" },
                      };
                   }
                } else if (toolIndex !== undefined && runTools[toolIndex]) { // Aggregating arguments
                   runTools[toolIndex].function!.arguments += args || "";
                } else {
                   console.warn("[OpenAI] Tool call aggregation error: missing id/index or index out of bounds", tool);
                }
              }

              // if (reasoning && reasoning.length > 0) {
              //   return { isThinking: true, content: reasoning };
              // } else
              if (content && content.length > 0) {
                return { isThinking: false, content: content };
              }

              return { isThinking: false, content: "" };
            },
            // processToolMessage - Appends tool call and results for OpenAI format
            (
              requestPayload: RequestPayload, // Correct type
              toolCallMessage: any, // assistant message with tool_calls
              toolCallResult: any[], // array of tool messages
            ) => {
              index = -1; // Reset index
              requestPayload?.messages?.push(
                toolCallMessage, // Assistant message with tool calls
                ...toolCallResult, // Tool messages with results
              );
            },
            options,
          );
        } else {
          // Non-streaming request (Chat or DALL-E)
          const chatPayload = {
            method: "POST",
            body: JSON.stringify(requestPayload),
            signal: controller.signal,
            headers: getHeaders(),
          };

          const requestTimeoutId = setTimeout(
            () => controller.abort(),
            getTimeoutMSByModel(options.config.model), // Use model-specific timeout
          );

          const res = await fetch(chatPath, chatPayload); // Use global or imported fetch
          clearTimeout(requestTimeoutId);

          const resJson = await res.json();

          if (resJson.error) {
             console.error("OpenAI API Error:", resJson.error);
             options.onError?.(new Error(resJson.error.message || "OpenAI API error"));
             return;
          }

          // Extract message handles both chat and DALL-E responses
          const message = await this.extractMessage(resJson);
          options.onFinish(message, res);
        }
      } catch (e) {
        console.log("[Request] failed to make a chat request", e);
        options.onError?.(e as Error);
      }
    }

  async usage() {
    const formatDate = (d: Date) =>
      `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
        .getDate()
        .toString()
        .padStart(2, "0")}`;
    const ONE_DAY = 1 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startDate = formatDate(startOfMonth);
    const endDate = formatDate(new Date(Date.now() + ONE_DAY));

    const [used, subs] = await Promise.all([
      fetch(
        this.path(
          `${OpenaiPath.UsagePath}?start_date=${startDate}&end_date=${endDate}`,
        ),
        {
          method: "GET",
          headers: getHeaders(),
        },
      ),
      fetch(this.path(OpenaiPath.SubsPath), {
        method: "GET",
        headers: getHeaders(),
      }),
    ]);

    if (used.status === 401) {
      throw new Error(Locale.Error.Unauthorized);
    }

    if (!used.ok || !subs.ok) {
      throw new Error("Failed to query usage from openai");
    }

    const response = (await used.json()) as {
      total_usage?: number;
      error?: {
        type: string;
        message: string;
      };
    };

    const total = (await subs.json()) as {
      hard_limit_usd?: number;
    };

    if (response.error && response.error.type) {
      throw Error(response.error.message);
    }

    if (response.total_usage) {
      response.total_usage = Math.round(response.total_usage) / 100;
    }

    if (total.hard_limit_usd) {
      total.hard_limit_usd = Math.round(total.hard_limit_usd * 100) / 100;
    }

    return {
      used: response.total_usage,
      total: total.hard_limit_usd,
    } as LLMUsage;
  }

  async models(): Promise<LLMModel[]> {
    if (this.disableListModels) {
      return DEFAULT_MODELS.slice();
    }

    const res = await fetch(this.path(OpenaiPath.ListModelPath), {
      method: "GET",
      headers: {
        ...getHeaders(),
      },
    });

    const resJson = (await res.json()) as OpenAIListModelResponse;
    const chatModels = resJson.data?.filter(
      (m) => m.id.startsWith("gpt-") || m.id.startsWith("chatgpt-"),
    );
    console.log("[Models]", chatModels);

    if (!chatModels) {
      return [];
    }

    //由于目前 OpenAI 的 disableListModels 默认为 true，所以当前实际不会运行到这场
    let seq = 1000; //同 Constant.ts 中的排序保持一致
    return chatModels.map((m) => ({
      name: m.id,
      available: true,
      sorted: seq++,
      provider: {
        id: "openai",
        providerName: "OpenAI",
        providerType: "openai",
        sorted: 1,
      },
    }));
  }
}
export { OpenaiPath };
