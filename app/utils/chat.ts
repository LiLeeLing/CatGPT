import {
  CACHE_URL_PREFIX,
  UPLOAD_URL,
  REQUEST_TIMEOUT_MS,
} from "@/app/constant";
import { MultimodalContent, RequestMessage } from "@/app/client/api";
import Locale from "@/app/locales";
import {
  EventStreamContentType,
  fetchEventSource,
} from "@fortaine/fetch-event-source";
import { prettyObject } from "./format";
import { fetch as tauriFetch } from "./stream";

// --- 插入以下新函数 ---
/**
 * 统一预处理函数：将消息内容中的缓存 URL 转换为 Base64 Data URL。
 * @param content 消息内容
 * @returns 处理后的消息内容
 */
export async function preProcessMultimodalContent(
  content: RequestMessage["content"],
): Promise<string | MultimodalContent[]> {
  if (typeof content === "string") {
    return content;
  }

  const processedContent: MultimodalContent[] = [];
  for (const item of content) {
    if (item.type === "image_url" && item.image_url?.url?.startsWith(CACHE_URL_PREFIX)) {
      try {
        // 调用函数获取 Base64 Data URL
        const base64DataUrl = await cacheImageToBase64Image(item.image_url.url);
        processedContent.push({
          type: "image_url",
          image_url: {
            url: base64DataUrl, // URL 现在是 Base64
          },
        });
      } catch (error) {
        console.error("[Chat] Error processing cached image:", item.image_url.url, error);
        // 处理错误，例如替换为错误提示文本
        processedContent.push({
          type: "text",
          text: `[Error processing image: ${item.image_url.url}]`,
        });
      }
    } else if (item.type === "file_url" && item.file_url?.url?.startsWith(CACHE_URL_PREFIX)) {
        // TODO: 文件处理逻辑 - 根据目标平台和文件类型决定
        // 示例：暂时将文件表示为文本提示
        console.warn("[Chat] File processing not fully implemented yet:", item.file_url.name);
        processedContent.push({
            type: "text",
            text: `[Attached file: ${item.file_url.name} - content processing pending]`
        });
        // 未来可能需要:
        // 1. 获取文件的 Base64: const base64DataUrl = await cacheMediaToBase64(item.file_url.url, item.file_url.mimeType);
        // 2. 或获取公网 URL (如果 uploadMedia 支持): const publicUrl = await getPublicUrlForCache(item.file_url.url);
        // processedContent.push({ ...item, file_url: { ...item.file_url, url: base64DataUrl or publicUrl } });
    }
     else {
      // 保留非缓存 URL (例如已经是 Base64 或公网 URL) 或纯文本部分
      processedContent.push(item);
    }
  }

  // 优化：如果只有一个文本部分，则返回字符串
  if (processedContent.length === 1 && processedContent[0].type === "text") {
    return processedContent[0].text ?? "";
  }

  return processedContent;
}


const imageCaches: Record<string, string> = {};
export function cacheImageToBase64Image(imageUrl: string) {
  if (imageUrl.includes(CACHE_URL_PREFIX)) {
    if (!imageCaches[imageUrl]) {
      const reader = new FileReader();
      return fetch(imageUrl, {
        method: "GET",
        mode: "cors",
        credentials: "include",
      })
        .then((res) => res.blob())
        .then(
          async (blob) =>
            (imageCaches[imageUrl] = await compressImage(blob, 256 * 1024)),
        ); // compressImage
    }
    return Promise.resolve(imageCaches[imageUrl]);
  }
  return Promise.resolve(imageUrl);
}

export function base64Image2Blob(base64Data: string, contentType: string) {
  const byteCharacters = atob(base64Data);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: contentType });
}

export function uploadImage(file: Blob): Promise<string> {
  if (!window._SW_ENABLED) {
    // if serviceWorker register error, using compressImage
    return compressImage(file, 256 * 1024);
  }
  const body = new FormData();
  body.append("file", file);
  return fetch(UPLOAD_URL, {
    method: "post",
    body,
    mode: "cors",
    credentials: "include",
  })
    .then((res) => res.json())
    .then((res) => {
      // console.log("res", res);
      if (res?.code == 0 && res?.data) {
        return res?.data;
      }
      throw Error(`upload Error: ${res?.msg}`);
    });
}

export function removeImage(imageUrl: string) {
  return fetch(imageUrl, {
    method: "DELETE",
    mode: "cors",
    credentials: "include",
  });
}

export function stream(
  chatPath: string,
  requestPayload: any,
  headers: any,
  tools: any[],
  funcs: Record<string, Function>,
  controller: AbortController,
  parseSSE: (text: string, runTools: any[]) => string | undefined,
  processToolMessage: (
    requestPayload: any,
    toolCallMessage: any,
    toolCallResult: any[],
  ) => void,
  options: any,
) {
  let responseText = "";
  let remainText = "";
  let finished = false;
  let running = false;
  let runTools: any[] = [];
  let responseRes: Response;

  // animate response to make it looks smooth
  function animateResponseText() {
    if (finished || controller.signal.aborted) {
      responseText += remainText;
      console.log("[Response Animation] finished");
      if (responseText?.length === 0) {
        options.onError?.(new Error("empty response from server"));
      }
      return;
    }

    if (remainText.length > 0) {
      const fetchCount = Math.max(1, Math.round(remainText.length / 60));
      const fetchText = remainText.slice(0, fetchCount);
      responseText += fetchText;
      remainText = remainText.slice(fetchCount);
      options.onUpdate?.(responseText, fetchText);
    }

    requestAnimationFrame(animateResponseText);
  }

  // start animaion
  animateResponseText();

  const finish = () => {
    if (!finished) {
      if (!running && runTools.length > 0) {
        const toolCallMessage = {
          role: "assistant",
          tool_calls: [...runTools],
        };
        running = true;
        runTools.splice(0, runTools.length); // empty runTools
        return Promise.all(
          toolCallMessage.tool_calls.map((tool) => {
            options?.onBeforeTool?.(tool);
            return Promise.resolve(
              // @ts-ignore
              funcs[tool.function.name](
                // @ts-ignore
                tool?.function?.arguments
                  ? JSON.parse(tool?.function?.arguments)
                  : {},
              ),
            )
              .then((res) => {
                let content = res.data || res?.statusText;
                // hotfix #5614
                content =
                  typeof content === "string"
                    ? content
                    : JSON.stringify(content);
                if (res.status >= 300) {
                  return Promise.reject(content);
                }
                return content;
              })
              .then((content) => {
                options?.onAfterTool?.({
                  ...tool,
                  content,
                  isError: false,
                });
                return content;
              })
              .catch((e) => {
                options?.onAfterTool?.({
                  ...tool,
                  isError: true,
                  errorMsg: e.toString(),
                });
                return e.toString();
              })
              .then((content) => ({
                name: tool.function.name,
                role: "tool",
                content,
                tool_call_id: tool.id,
              }));
          }),
        ).then((toolCallResult) => {
          processToolMessage(requestPayload, toolCallMessage, toolCallResult);
          setTimeout(() => {
            // call again
            console.debug("[ChatAPI] restart");
            running = false;
            chatApi(chatPath, headers, requestPayload, tools); // call fetchEventSource
          }, 60);
        });
        return;
      }
      if (running) {
        return;
      }
      console.debug("[ChatAPI] end");
      finished = true;
      options.onFinish(responseText + remainText, responseRes); // 将res传递给onFinish
    }
  };

  controller.signal.onabort = finish;

  function chatApi(
    chatPath: string,
    headers: any,
    requestPayload: any,
    tools: any,
  ) {
    const chatPayload = {
      method: "POST",
      body: JSON.stringify({
        ...requestPayload,
        tools: tools && tools.length ? tools : undefined,
      }),
      signal: controller.signal,
      headers,
    };
    const requestTimeoutId = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    fetchEventSource(chatPath, {
      fetch: tauriFetch as any,
      ...chatPayload,
      async onopen(res) {
        clearTimeout(requestTimeoutId);
        const contentType = res.headers.get("content-type");
        console.log("[Request] response content type: ", contentType);
        responseRes = res;

        if (contentType?.startsWith("text/plain")) {
          responseText = await res.clone().text();
          return finish();
        }

        if (
          !res.ok ||
          !res.headers
            .get("content-type")
            ?.startsWith(EventStreamContentType) ||
          res.status !== 200
        ) {
          const responseTexts = [responseText];
          let extraInfo = await res.clone().text();
          try {
            const resJson = await res.clone().json();
            extraInfo = prettyObject(resJson);
          } catch {}

          if (res.status === 401) {
            responseTexts.push(Locale.Error.Unauthorized);
          }

          if (extraInfo) {
            responseTexts.push(extraInfo);
          }

          responseText = responseTexts.join("\n\n");

          return finish();
        }
      },
      onmessage(msg) {
        if (msg.data === "[DONE]" || finished) {
          return finish();
        }
        const text = msg.data;
        // Skip empty messages
        if (!text || text.trim().length === 0) {
          return;
        }
        try {
          const chunk = parseSSE(text, runTools);
          if (chunk) {
            remainText += chunk;
          }
        } catch (e) {
          console.error("[Request] parse error", text, msg, e);
        }
      },
      onclose() {
        finish();
      },
      onerror(e) {
        options?.onError?.(e);
        throw e;
      },
      openWhenHidden: true,
    });
  }
  console.debug("[ChatAPI] start");
  chatApi(chatPath, headers, requestPayload, tools); // call fetchEventSource
}

export function streamWithThink(
  chatPath: string,
  requestPayload: any,
  headers: any,
  tools: any[],
  funcs: Record<string, Function>,
  controller: AbortController,
  parseSSE: (
    text: string,
    runTools: any[],
  ) => {
    isThinking: boolean;
    content: string | undefined;
  },
  processToolMessage: (
    requestPayload: any,
    toolCallMessage: any,
    toolCallResult: any[],
  ) => void,
  options: any,
) {
  let responseText = "";
  let remainText = "";
  let finished = false;
  let running = false;
  let runTools: any[] = [];
  let responseRes: Response;
  let isInThinkingMode = false;
  let lastIsThinking = false;
  let lastIsThinkingTagged = false; //between <think> and </think> tags

  // animate response to make it looks smooth
  function animateResponseText() {
    if (finished || controller.signal.aborted) {
      responseText += remainText;
      console.log("[Response Animation] finished");
      if (responseText?.length === 0) {
        options.onError?.(new Error("empty response from server"));
      }
      return;
    }

    if (remainText.length > 0) {
      const fetchCount = Math.max(1, Math.round(remainText.length / 60));
      const fetchText = remainText.slice(0, fetchCount);
      responseText += fetchText;
      remainText = remainText.slice(fetchCount);
      options.onUpdate?.(responseText, fetchText);
    }

    requestAnimationFrame(animateResponseText);
  }

  // start animaion
  animateResponseText();

  const finish = () => {
    if (!finished) {
      if (!running && runTools.length > 0) {
        const toolCallMessage = {
          role: "assistant",
          tool_calls: [...runTools],
        };
        running = true;
        runTools.splice(0, runTools.length); // empty runTools
        return Promise.all(
          toolCallMessage.tool_calls.map((tool) => {
            options?.onBeforeTool?.(tool);
            return Promise.resolve(
              // @ts-ignore
              funcs[tool.function.name](
                // @ts-ignore
                tool?.function?.arguments
                  ? JSON.parse(tool?.function?.arguments)
                  : {},
              ),
            )
              .then((res) => {
                let content = res.data || res?.statusText;
                // hotfix #5614
                content =
                  typeof content === "string"
                    ? content
                    : JSON.stringify(content);
                if (res.status >= 300) {
                  return Promise.reject(content);
                }
                return content;
              })
              .then((content) => {
                options?.onAfterTool?.({
                  ...tool,
                  content,
                  isError: false,
                });
                return content;
              })
              .catch((e) => {
                options?.onAfterTool?.({
                  ...tool,
                  isError: true,
                  errorMsg: e.toString(),
                });
                return e.toString();
              })
              .then((content) => ({
                name: tool.function.name,
                role: "tool",
                content,
                tool_call_id: tool.id,
              }));
          }),
        ).then((toolCallResult) => {
          processToolMessage(requestPayload, toolCallMessage, toolCallResult);
          setTimeout(() => {
            // call again
            console.debug("[ChatAPI] restart");
            running = false;
            chatApi(chatPath, headers, requestPayload, tools); // call fetchEventSource
          }, 60);
        });
        return;
      }
      if (running) {
        return;
      }
      console.debug("[ChatAPI] end");
      finished = true;
      options.onFinish(responseText + remainText, responseRes);
    }
  };

  controller.signal.onabort = finish;

  function chatApi(
    chatPath: string,
    headers: any,
    requestPayload: any,
    tools: any,
  ) {
    const chatPayload = {
      method: "POST",
      body: JSON.stringify({
        ...requestPayload,
        tools: tools && tools.length ? tools : undefined,
      }),
      signal: controller.signal,
      headers,
    };
    const requestTimeoutId = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    fetchEventSource(chatPath, {
      fetch: tauriFetch as any,
      ...chatPayload,
      async onopen(res) {
        clearTimeout(requestTimeoutId);
        const contentType = res.headers.get("content-type");
        console.log("[Request] response content type: ", contentType);
        responseRes = res;

        if (contentType?.startsWith("text/plain")) {
          responseText = await res.clone().text();
          return finish();
        }

        if (
          !res.ok ||
          !res.headers
            .get("content-type")
            ?.startsWith(EventStreamContentType) ||
          res.status !== 200
        ) {
          const responseTexts = [responseText];
          let extraInfo = await res.clone().text();
          try {
            const resJson = await res.clone().json();
            extraInfo = prettyObject(resJson);
          } catch {}

          if (res.status === 401) {
            responseTexts.push(Locale.Error.Unauthorized);
          }

          if (extraInfo) {
            responseTexts.push(extraInfo);
          }

          responseText = responseTexts.join("\n\n");

          return finish();
        }
      },
      onmessage(msg) {
        if (msg.data === "[DONE]" || finished) {
          return finish();
        }
        const text = msg.data;
        // Skip empty messages
        if (!text || text.trim().length === 0) {
          return;
        }
        try {
          const chunk = parseSSE(text, runTools);
          // Skip if content is empty
          if (!chunk?.content || chunk.content.length === 0) {
            return;
          }

          // deal with <think> and </think> tags start
          if (!chunk.isThinking) {
            if (chunk.content.startsWith("<think>")) {
              chunk.isThinking = true;
              chunk.content = chunk.content.slice(7).trim();
              lastIsThinkingTagged = true;
            } else if (chunk.content.endsWith("</think>")) {
              chunk.isThinking = false;
              chunk.content = chunk.content.slice(0, -8).trim();
              lastIsThinkingTagged = false;
            } else if (lastIsThinkingTagged) {
              chunk.isThinking = true;
            }
          }
          // deal with <think> and </think> tags start

          // Check if thinking mode changed
          const isThinkingChanged = lastIsThinking !== chunk.isThinking;
          lastIsThinking = chunk.isThinking;

          if (chunk.isThinking) {
            // If in thinking mode
            if (!isInThinkingMode || isThinkingChanged) {
              // If this is a new thinking block or mode changed, add prefix
              isInThinkingMode = true;
              if (remainText.length > 0) {
                remainText += "\n";
              }
              remainText += "> " + chunk.content;
            } else {
              // Handle newlines in thinking content
              if (chunk.content.includes("\n\n")) {
                const lines = chunk.content.split("\n\n");
                remainText += lines.join("\n\n> ");
              } else {
                remainText += chunk.content;
              }
            }
          } else {
            // If in normal mode
            if (isInThinkingMode || isThinkingChanged) {
              // If switching from thinking mode to normal mode
              isInThinkingMode = false;
              remainText += "\n\n" + chunk.content;
            } else {
              remainText += chunk.content;
            }
          }
        } catch (e) {
          console.error("[Request] parse error", text, msg, e);
          // Don't throw error for parse failures, just log them
        }
      },
      onclose() {
        finish();
      },
      onerror(e) {
        options?.onError?.(e);
        throw e;
      },
      openWhenHidden: true,
    });
  }
  console.debug("[ChatAPI] start");
  chatApi(chatPath, headers, requestPayload, tools); // call fetchEventSource
}
