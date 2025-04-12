import {
    getMessageTextContent,
    isDalle3,
    safeLocalStorage,
    trimTopic,
  } from "../utils";

  import { indexedDBStorage } from "@/app/utils/indexedDB-storage";
  import { nanoid } from "nanoid";
  import type {
    ClientApi,
    MultimodalContent,
    RequestMessage,
    UploadFile,
  } from "../client/api";
  import { getClientApi } from "../client/api";
  import { ChatControllerPool } from "../client/controller";
  import { showToast } from "../components/ui-lib";
  import {
    DEFAULT_INPUT_TEMPLATE,
    DEFAULT_MODELS,
    DEFAULT_SYSTEM_TEMPLATE,
    GEMINI_SUMMARIZE_MODEL,
    DEEPSEEK_SUMMARIZE_MODEL,
    KnowledgeCutOffDate,
    MCP_SYSTEM_TEMPLATE,
    MCP_TOOLS_TEMPLATE,
    ServiceProvider,
    StoreKey,
    SUMMARIZE_MODEL,
  } from "../constant";
  import {
    MessageContent, // 导入新的类型
    TextContent,
    ImageContent,
    FileContent,
  } from "../typing"; // 导入新的类型
  import Locale, { getLang } from "../locales";
  import { isVisionModel, readFileContent } from "../utils";
  import { prettyObject } from "../utils/format";
  import { createPersistStore } from "../utils/store";
  import { estimateTokenLength } from "../utils/token";
  import { ModelConfig, ModelType, useAppConfig } from "./config";
  import { useAccessStore } from "./access";
  import { collectModelsWithDefaultModel } from "../utils/model";
  import { createEmptyMask, Mask } from "./mask";
  import { executeMcpAction, getAllTools, isMcpEnabled } from "../mcp/actions";
  import { extractMcpJson, isMcpJson } from "../mcp/utils";

  const localStorage = safeLocalStorage();

  export type ChatMessageTool = {
    id: string;
    index?: number;
    type?: string;
    function?: {
      name: string;
      arguments?: string;
    };
    content?: string;
    isError?: boolean;
    errorMsg?: string;
  };

  export type ChatMessage = RequestMessage & {
    date: string;
    streaming?: boolean;
    isError?: boolean;
    id: string;
    model?: ModelType;
    tools?: ChatMessageTool[];
    audio_url?: string;
    isMcpResponse?: boolean;
  };

  export function createMessage(override: Partial<ChatMessage>): ChatMessage {
    return {
      id: nanoid(),
      date: new Date().toLocaleString(),
      role: "user",
      content: "",
      ...override,
    };
  }

  export interface ChatStat {
    tokenCount: number;
    wordCount: number;
    charCount: number;
  }

  export interface ChatSession {
    id: string;
    topic: string;

    memoryPrompt: string;
    messages: ChatMessage[];
    stat: ChatStat;
    lastUpdate: number;
    lastSummarizeIndex: number;
    clearContextIndex?: number;

    mask: Mask;
  }

  export const DEFAULT_TOPIC = Locale.Store.DefaultTopic;
  export const BOT_HELLO: ChatMessage = createMessage({
    role: "assistant",
    content: Locale.Store.BotHello,
  });

  function createEmptySession(): ChatSession {
    return {
      id: nanoid(),
      topic: DEFAULT_TOPIC,
      memoryPrompt: "",
      messages: [],
      stat: {
        tokenCount: 0,
        wordCount: 0,
        charCount: 0,
      },
      lastUpdate: Date.now(),
      lastSummarizeIndex: 0,

      mask: createEmptyMask(),
    };
  }

function estimateTokenLengthForContent(content: string | MessageContent[]): number {
  if (typeof content === 'string') {
    // 对字符串内容的现有逻辑
    return estimateTokenLength(content);
  } else if (Array.isArray(content)) {
    // 对 MessageContent 数组的逻辑
    let totalTokens = 0;
    content.forEach(part => {
      if (part.type === 'text') {
        totalTokens += estimateTokenLength(part.text ?? "");
      } else if (part.type === 'image_url') {
        // 与 getMessagesWithMemory 一致: 每张图片约 1000 token (如果需要可调整)
        totalTokens += 1000;
      } else if (part.type === 'file_url') {
        // 与 getMessagesWithMemory 一致: 使用提供的 tokenCount 或默认值 (50)
        // 确保在 chat.tsx 上传时准确计算 tokenCount
        totalTokens += part.file_url.tokenCount ?? 50; // 如果 tokenCount 缺失，默认为 50
      }
    });
    return totalTokens;
  }
  return 0; // 对于有效的内容类型不应发生
}


  function countMessages(msgs: ChatMessage[]): number {
    return msgs.reduce(
      (pre, cur) => pre + estimateTokenLengthForContent(cur.content), // 使用新的估算函数
      0,
    );
  }

  function fillTemplateWith(input: string, modelConfig: ModelConfig) {
    const cutoff =
      KnowledgeCutOffDate[modelConfig.model] ?? KnowledgeCutOffDate.default;
    // Find the model in the DEFAULT_MODELS array that matches the modelConfig.model
    const modelInfo = DEFAULT_MODELS.find((m) => m.name === modelConfig.model);

    var serviceProvider = "OpenAI";
    if (modelInfo) {
      // TODO: auto detect the providerName from the modelConfig.model

      // Directly use the providerName from the modelInfo
      serviceProvider = modelInfo.provider.providerName;
    }

    const vars = {
      ServiceProvider: serviceProvider,
      cutoff,
      model: modelConfig.model,
      time: new Date().toString(),
      lang: getLang(),
      input: input,
    };

    let output = modelConfig.template ?? DEFAULT_INPUT_TEMPLATE;

    // remove duplicate
    if (input.startsWith(output)) {
      output = "";
    }

    // must contains {{input}}
    const inputVar = "{{input}}";
    if (!output.includes(inputVar)) {
      output += "\n" + inputVar;
    }

    Object.entries(vars).forEach(([name, value]) => {
      const regex = new RegExp(`{{${name}}}`, "g");
      output = output.replace(regex, value.toString()); // Ensure value is a string
    });

    return output;
  }

  async function getMcpSystemPrompt(): Promise<string> {
    const tools = await getAllTools();

    let toolsStr = "";

    tools.forEach((i) => {
      // error client has no tools
      if (!i.tools) return;

      toolsStr += MCP_TOOLS_TEMPLATE.replace(
        "{{ clientId }}",
        i.clientId,
      ).replace(
        "{{ tools }}",
        i.tools.tools.map((p: object) => JSON.stringify(p, null, 2)).join("\n"),
      );
    });

    return MCP_SYSTEM_TEMPLATE.replace("{{ MCP_TOOLS }}", toolsStr);
  }

  const DEFAULT_CHAT_STATE = {
    sessions: [createEmptySession()],
    currentSessionIndex: 0,
    lastInput: "",
  };

  export const useChatStore = createPersistStore(
    DEFAULT_CHAT_STATE,
    (set, _get) => {
      function get() {
        return {
          ..._get(),
          ...methods,
        };
      }

      const methods = {
        forkSession() {
          // 获取当前会话
          const currentSession = get().currentSession();
          if (!currentSession) return;

          const newSession = createEmptySession();

          newSession.topic = currentSession.topic;
          // 深拷贝消息
          newSession.messages = currentSession.messages.map((msg) => ({
            ...msg,
            id: nanoid(), // 生成新的消息 ID
          }));
          newSession.mask = {
            ...currentSession.mask,
            modelConfig: {
              ...currentSession.mask.modelConfig,
            },
          };

          set((state) => ({
            currentSessionIndex: 0,
            sessions: [newSession, ...state.sessions],
          }));
        },

        clearSessions() {
          set(() => ({
            sessions: [createEmptySession()],
            currentSessionIndex: 0,
          }));
        },

        selectSession(index: number) {
          set({
            currentSessionIndex: index,
          });
        },

        moveSession(from: number, to: number) {
          set((state) => {
            const { sessions, currentSessionIndex: oldIndex } = state;

            // move the session
            const newSessions = [...sessions];
            const session = newSessions[from];
            newSessions.splice(from, 1);
            newSessions.splice(to, 0, session);

            // modify current session id
            let newIndex = oldIndex === from ? to : oldIndex;
            if (oldIndex > from && oldIndex <= to) {
              newIndex -= 1;
            } else if (oldIndex < from && oldIndex >= to) {
              newIndex += 1;
            }

            return {
              currentSessionIndex: newIndex,
              sessions: newSessions,
            };
          });
        },

        newSession(mask?: Mask) {
          const session = createEmptySession();

          if (mask) {
            const config = useAppConfig.getState();
            const globalModelConfig = config.modelConfig;

            session.mask = {
              ...mask,
              modelConfig: {
                ...globalModelConfig,
                ...mask.modelConfig,
              },
            };
            session.topic = mask.name;
          }

          set((state) => ({
            currentSessionIndex: 0,
            sessions: [session].concat(state.sessions),
          }));
        },

        nextSession(delta: number) {
          const n = get().sessions.length;
          const limit = (x: number) => (x + n) % n;
          const i = get().currentSessionIndex;
          get().selectSession(limit(i + delta));
        },

        deleteSession(index: number) {
          const deletingLastSession = get().sessions.length === 1;
          const deletedSession = get().sessions.at(index);

          if (!deletedSession) return;

          const sessions = get().sessions.slice();
          sessions.splice(index, 1);

          const currentIndex = get().currentSessionIndex;
          let nextIndex = Math.min(
            currentIndex - Number(index < currentIndex),
            sessions.length - 1,
          );

          if (deletingLastSession) {
            nextIndex = 0;
            sessions.push(createEmptySession());
          }

          // for undo delete action
          const restoreState = {
            currentSessionIndex: get().currentSessionIndex,
            sessions: get().sessions.slice(),
          };

          set(() => ({
            currentSessionIndex: nextIndex,
            sessions,
          }));

          showToast(
            Locale.Home.DeleteToast,
            {
              text: Locale.Home.Revert,
              onClick() {
                set(() => restoreState);
              },
            },
            5000,
          );
        },

        currentSession() {
          let index = get().currentSessionIndex;
          const sessions = get().sessions;

          if (index < 0 || index >= sessions.length) {
            index = Math.min(sessions.length - 1, Math.max(0, index));
            set(() => ({ currentSessionIndex: index }));
          }

          const session = sessions[index];

          return session;
        },

        onNewMessage(message: ChatMessage, targetSession: ChatSession) {
          get().updateTargetSession(targetSession, (session) => {
            session.messages = session.messages.concat();
            session.lastUpdate = Date.now();
          });

          get().updateStat(message, targetSession);

          get().checkMcpJson(message);

          get().summarizeSession(false, targetSession);
        },

        async onUserInput(

          userInputText: string, // 用户输入的文本

                    // attachFiles?: UploadFile[],
          // attachImages?: string[],
          attachments?: UploadFile[],
          attachImages?: string[],
          isMcpResponse?: boolean,
        ) {
          const session = get().currentSession();
          const modelConfig = session.mask.modelConfig;
          const currentModel = modelConfig.model; // 获取当前模型名称
          const accessStore = useAccessStore.getState(); // 获取 access store
          const configStore = useAppConfig.getState(); // 获取 config store

                      const messageContents: MessageContent[] = [];
                      const modelIsVision = isVisionModel(currentModel); // 检查模型是否支持 Vision

                      // 1. 添加用户文本输入
                      if (userInputText && !isMcpResponse) {
                        const filledText = fillTemplateWith(userInputText, modelConfig);
                        messageContents.push({ type: "text", text: filledText });
                      } else if (userInputText && isMcpResponse) {
                        // MCP 响应直接使用文本
                        messageContents.push({ type: "text", text: userInputText });
                      }

                      // 2. 处理图片附件 (attachImages)
                      if (attachImages && attachImages.length > 0) {
                        if (modelIsVision) {
                          attachImages.forEach(imageUrl => {
                            // 确保 imageUrl 是有效的 base64 编码或 URL
                            if (imageUrl && typeof imageUrl === 'string') {
                               messageContents.push({ type: "image_url", image_url: { url: imageUrl } });
                            } else {
                               console.warn("Invalid image URL provided:", imageUrl);
                            }
                          });
                        } else {
                          console.warn(`Model ${currentModel} does not support images. Skipping images.`);
                          messageContents.push({ type: "text", text: `[${attachImages.length} image(s) were uploaded but ignored as the current model doesn't support images]` });
                        }
                      }

                      // 3. 处理文件附件 (attachFiles)
                      if (attachFiles && attachFiles.length > 0) {
                        for (const file of attachFiles) {
                          // 使用 file_url 策略处理所有文件
                          messageContents.push({
                            type: "file_url",
                            file_url: file, // 包含 url, name, tokenCount, mimeType 等
                          });
                          // 确保 file.tokenCount 在 chat.tsx 上传时已计算并填充
                          if (file.tokenCount === undefined) {
                             console.warn(`Token count for file ${file.name} is undefined. Using default estimate.`);
                          }
                        }
                      }


           // 检查 messageContents 是否为空
           if (messageContents.length === 0) {
             showToast(Locale.Chat.UploadButNoInput); // 或者其他提示
             return; // 不发送空消息
           }

           // --- 创建消息对象 ---
           const userMessage: ChatMessage = createMessage({
             role: "user",
             content: messageContents, // 使用构建好的数组
             isMcpResponse,
           });

           const botMessage: ChatMessage = createMessage({
             role: "assistant",
             streaming: true,
             model: modelConfig.model,
           });

           // get recent messages
           const recentMessages = await get().getMessagesWithMemory(); // This now returns RequestMessage[]
           const sendMessages = recentMessages.concat(userMessage as RequestMessage); // Cast or ensure type compatibility

           // save user's and bot's message
           get().updateTargetSession(session, (session) => {
             session.messages = session.messages.concat([userMessage, botMessage]);
           });


        const api: ClientApi = getClientApi(modelConfig.providerName);

        // --- 发起 API 请求 ---
        // 传递给 api.llm.chat 的 messages 数组现在包含了 content 为数组的消息
        api.llm.chat({
          messages: sendMessages, // sendMessages 包含结构化 content
          config: { ...modelConfig, stream: true },
          onUpdate(message) {
            botMessage.streaming = true;
            if (message) {
              // 假设 API 返回的仍然是文本内容
              botMessage.content = message;
            }
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
          },
          async onFinish(message) {
            botMessage.streaming = false;
            if (message) {
              botMessage.content = message;
              botMessage.date = new Date().toLocaleString();
              // 注意：onNewMessage 可能也需要调整以处理 content 数组（如果需要统计 token 等）
              get().onNewMessage(botMessage, session);
            }
            ChatControllerPool.remove(session.id, botMessage.id);
          },
          // ... (onBeforeTool, onAfterTool, onError, onController 保持不变)
          onBeforeTool(tool: ChatMessageTool) {
            (botMessage.tools = botMessage?.tools || []).push(tool);
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
          },
          onAfterTool(tool: ChatMessageTool) {
            botMessage?.tools?.forEach((t, i, tools) => {
              if (tool.id == t.id) {
                tools[i] = { ...tool };
              }
            });
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
          },
          onError(error) {
            const isAborted = error.message?.includes?.("aborted");
            // 假设错误信息仍然附加到文本 content
            const errorContent =
              "\n\n" +
              prettyObject({
                error: true,
                message: error.message,
              });
            if (typeof botMessage.content === "string") {
              botMessage.content += errorContent;
            } else {
              // 如果 botMessage.content 也是数组，需要找到 text 部分添加
              const textPart = botMessage.content.find(
                (p) => p.type === "text",
              ) as TextContent | undefined;
              if (textPart) {
                textPart.text += errorContent;
              } else {
                // 如果没有 text 部分，则添加一个新的 text 部分
                (botMessage.content as MessageContent[]).push({
                  type: "text",
                  text: errorContent,
                });
              }
            }

            botMessage.streaming = false;
            userMessage.isError = !isAborted;
            botMessage.isError = !isAborted;
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
            ChatControllerPool.remove(session.id, botMessage.id);

            console.error("[Chat] failed ", error);
          },
          onController(controller) {
            ChatControllerPool.addController(
              session.id,
              botMessage.id, // 确保 botMessage.id 存在
              controller,
            );
          },
        });
      },


        getMemoryPrompt() {
          const session = get().currentSession();

          if (session.memoryPrompt.length) {
            return {
              role: "system",
              content: Locale.Store.Prompt.History(session.memoryPrompt),
              date: "",
            } as ChatMessage;
          }
        },

async getMessagesWithMemory(): Promise<RequestMessage[]> {
  const session = get().currentSession();
  const modelConfig = session.mask.modelConfig;
  const currentModel = modelConfig.model;
  const modelIsVision = isVisionModel(currentModel);

  // TODO: 实现一个检查模型是否支持文件的方法
  // 这可以基于模型名称模式、配置中的列表等。
  const checkModelFileSupport = (modelName: string): boolean => {
     // 示例：允许已知支持文件的特定模型
     // 用你的实际逻辑替换，基于模型能力
     // return modelName.includes("gpt-4-turbo") || modelName.includes("claude-3");
     // 目前，假设大多数模型不支持，除非明确知道
     // return false; // 如果不确定，默认为 false
     // 或者，更实际地，检查已知的支持模型/提供商：
     const provider = session.mask.modelConfig.providerName;
     if (provider === ServiceProvider.OpenAI && (modelName.includes("gpt-4"))) {
         return true; // 示例：假设 GPT-4 模型通过 API 支持文件
     }
     if (provider === ServiceProvider.Anthropic && modelName.includes("claude-3")) {
         return true; // 示例：假设 Claude 3 支持文件
     }
     // 根据需要添加对其他提供商/模型的检查
     return false; // 默认假设
  };
  const modelSupportsFiles = checkModelFileSupport(currentModel);

  const clearContextIndex = session.clearContextIndex ?? 0;
  const messages = session.messages.slice();
  const totalMessageCount = session.messages.length;

  const contextPrompts = session.mask.context.slice();
  const shouldInjectSystemPrompts =
    modelConfig.enableInjectSystemPrompts &&
    (session.mask.modelConfig.model.startsWith("gpt-") ||
      session.mask.modelConfig.model.startsWith("chatgpt-"));

  const mcpEnabled = await isMcpEnabled();
  const mcpSystemPrompt = mcpEnabled ? await getMcpSystemPrompt() : "";

  var systemPrompts: ChatMessage[] = [];
  if (shouldInjectSystemPrompts) {
    systemPrompts = [
      createMessage({
        role: "system",
        content:
          fillTemplateWith("", {
            ...modelConfig,
            template: DEFAULT_SYSTEM_TEMPLATE,
          }) + mcpSystemPrompt,
      }),
    ];
  } else if (mcpEnabled) {
    systemPrompts = [
      createMessage({
        role: "system",
        content: mcpSystemPrompt,
      }),
    ];
  }

  if (shouldInjectSystemPrompts || mcpEnabled) {
    console.log(
      "[Global System Prompt] ",
      systemPrompts.at(0)?.content ?? "empty",
    );
  }

  const memoryPrompt = get().getMemoryPrompt();
  const shouldSendLongTermMemory =
    modelConfig.sendMemory &&
    session.memoryPrompt &&
    session.memoryPrompt.length > 0 &&
    session.lastSummarizeIndex > clearContextIndex;
  const longTermMemoryPrompts =
    shouldSendLongTermMemory && memoryPrompt ? [memoryPrompt] : [];
  const longTermMemoryStartIndex = session.lastSummarizeIndex;

  const shortTermMemoryStartIndex = Math.max(
    0,
    totalMessageCount - modelConfig.historyMessageCount,
  );

  const memoryStartIndex = shouldSendLongTermMemory
    ? Math.min(longTermMemoryStartIndex, shortTermMemoryStartIndex)
    : shortTermMemoryStartIndex;
  const contextStartIndex = Math.max(clearContextIndex, memoryStartIndex);
  const maxTokenThreshold = modelConfig.max_tokens;

  const reversedRecentMessages = [];
  let tokenCount = 0;

  for (let i = totalMessageCount - 1; i >= contextStartIndex; i--) {
    const msg = messages[i];
    let currentMsgToken = 0;
    let msgToSend: RequestMessage | null = null;

    // 根据内容类型计算消息的 token 数量
    if (typeof msg.content === 'string') {
      currentMsgToken = estimateTokenLength(msg.content);
      msgToSend = { role: msg.role, content: msg.content };
    } else if (Array.isArray(msg.content)) {
      let tempContent: MessageContent[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          currentMsgToken += estimateTokenLength(part.text ?? "");
          tempContent.push(part);
        } else if (part.type === 'image_url') {
          // 仅当模型支持视觉时才计算图片 token
          if (modelIsVision) {
            currentMsgToken += 1000; // 图片 token 估算值
            tempContent.push(part);
          }
        } else if (part.type === 'file_url') {
          // 总是计算文件 token，如果需要，稍后过滤
          currentMsgToken += part.file_url.tokenCount ?? 50; // 使用存储的计数或默认值
          tempContent.push(part);
        }
      }
      if (tempContent.length > 0) {
         msgToSend = { role: msg.role, content: tempContent };
      } else {
         // 如果在潜在过滤后（例如，非视觉模型），数组为空，
         // 尝试恢复原始文本内容（如果存在）。
         const originalText = getMessageTextContent(msg); // 假设 getMessageTextContent 处理数组
         if (originalText) {
            currentMsgToken = estimateTokenLength(originalText);
            msgToSend = { role: msg.role, content: originalText };
         }
      }
    }

    // 检查添加此消息是否超过 token 阈值
    if (msgToSend && tokenCount + currentMsgToken <= maxTokenThreshold) {
      tokenCount += currentMsgToken;
      // 添加 originalId 以便在过滤期间进行潜在的回退
      reversedRecentMessages.push({ ...msgToSend, originalId: msg.id } as any);
    } else {
      // 如果达到或超过阈值，则停止添加消息
      break;
    }
  }

  // 组合消息历史的所有部分
  const finalMessages: RequestMessage[] = [
    ...(systemPrompts as RequestMessage[]),
    ...(longTermMemoryPrompts as RequestMessage[]),
    ...(contextPrompts as RequestMessage[]),
    ...reversedRecentMessages.reverse(),
  ];

  // --- 后处理：如果模型不支持视觉，则过滤图片 ---
  if (!modelIsVision) {
    finalMessages.forEach(message => {
      if (Array.isArray(message.content)) {
        const originalContentLength = message.content.length;
        message.content = message.content.filter(part => part.type !== 'image_url');

        // 如果过滤移除了所有部分但原始消息有文本，则执行回退逻辑
        if (message.content.length === 0 && originalContentLength > 0) {
           const originalMsg = messages.find(m => m.id === (message as any).originalId);
           const textContent = getMessageTextContent(originalMsg || message as ChatMessage);
           if (textContent) {
             message.content = textContent; // 降级为纯文本
           }
        } else if (message.content.length === 1 && message.content[0].type === 'text') {
           // 如果只剩下文本，则简化回字符串
           message.content = message.content[0].text ?? "";
        }
      }
    });
  }

  // --- 后处理：如果模型不支持文件，则过滤文件 ---
  if (!modelSupportsFiles) {
    finalMessages.forEach(message => {
      if (Array.isArray(message.content)) {
        const originalContentLength = message.content.length;
        message.content = message.content.filter(part => part.type !== 'file_url');

        // 类似于图片过滤的回退逻辑
        if (message.content.length === 0 && originalContentLength > 0) {
           const originalMsg = messages.find(m => m.id === (message as any).originalId);
           const textContent = getMessageTextContent(originalMsg || message as ChatMessage);
           if (textContent) {
             message.content = textContent; // 降级为纯文本
           }
        } else if (message.content.length === 1 && message.content[0].type === 'text') {
           // 如果只剩下文本，则简化回字符串
           message.content = message.content[0].text ?? "";
        }
      }
    });
  }

  // 过滤完成后清理 originalId
  finalMessages.forEach(message => {
    delete (message as any).originalId;
  });

  // 可选：过滤掉过滤后可能完全变空的消息
  // finalMessages = finalMessages.filter(msg => msg.content && (!Array.isArray(msg.content) || msg.content.length > 0));

  return finalMessages;
},


      updateMessage(
        sessionIndex: number,
        messageIndex: number,
        updater: (message?: ChatMessage) => void,
      ) {
        const sessions = get().sessions;
        const session = sessions.at(sessionIndex);
        const messages = session?.messages;
        updater(messages?.at(messageIndex));
        set(() => ({ sessions }));
      },

      resetSession(session: ChatSession) {
        get().updateTargetSession(session, (session) => {
          session.messages = [];
          session.memoryPrompt = "";
        });
      },

      summarizeSession(
        refreshTitle: boolean = false,
        targetSession: ChatSession,
      ) {
        const config = useAppConfig.getState();
        const session = targetSession;
        const modelConfig = session.mask.modelConfig;
        if (isDalle3(modelConfig.model)) {
          return;
        }

        const [model, providerName] = modelConfig.compressModel
          ? [modelConfig.compressModel, modelConfig.compressProviderName]
          : getSummarizeModel(
              session.mask.modelConfig.model,
              session.mask.modelConfig.providerName,
            );
        const api: ClientApi = getClientApi(providerName as ServiceProvider);

        const messages = session.messages;

        const SUMMARIZE_MIN_LEN = 50;
        // !!! 注意：countMessages 需要能处理 content 数组 !!!
        // 你需要修改 estimateTokenLength 或 countMessages 来正确计算数组 content 的 token
        if (
          (config.enableAutoGenerateTitle &&
            session.topic === DEFAULT_TOPIC &&
            countMessages(messages) >= SUMMARIZE_MIN_LEN) || // 假设 countMessages 已更新
          refreshTitle
        ) {
          // ... (生成标题的逻辑，确保传递给 API 的消息格式正确)
          const startIndex = Math.max(
            0,
            messages.length - modelConfig.historyMessageCount,
          );
              // --- 将 ChatMessage[] 转换为 RequestMessage[] 用于标题 API ---
              // 选项 A: 假设标题 API 只需要纯文本
              const finalTopicMessages: RequestMessage[] = topicMessages.map(msg => ({
                role: msg.role,
                content: getMessageTextContent(msg), // 仅提取文本内容
              }));
              // 选项 B: 假设标题 API 可以处理 MessageContent[] (对于摘要不太可能)
              /*
              const finalTopicMessages: RequestMessage[] = topicMessages.map(msg => ({
                role: msg.role,
                content: typeof msg.content === 'string'
                         ? msg.content // 或者包装: [{ type: 'text', text: msg.content }]
                         : msg.content.filter(p => p.type === 'text'), // 示例：为标题过滤非文本
              }));
              */


          // 确保传递给 chat 的 messages 是 RequestMessage[]
          api.llm.chat({
            // messages: topicMessages as RequestMessage[], // 需要类型转换或确保类型正确
            messages: finalTopicMessages, // 使用转换后的数组
            config: {
              model,
              stream: false,
              providerName,
            },
            onFinish(message, responseRes) {
              if (responseRes?.status === 200) {
                get().updateTargetSession(
                  session,
                  (session) =>
                    (session.topic =
                      message.length > 0 ? trimTopic(message) : DEFAULT_TOPIC),
                );
              }
            },
          });
        }

        const summarizeIndex = Math.max(
          session.lastSummarizeIndex,
          session.clearContextIndex ?? 0,
        );
        let toBeSummarizedMsgs = messages
          .filter((msg) => !msg.isError)
          .slice(summarizeIndex);

        // !!! countMessages 需要更新 !!!
        const historyMsgLength = countMessages(toBeSummarizedMsgs); // 假设 countMessages 已更新

        if (historyMsgLength > (modelConfig?.max_tokens || 4000)) {
          const n = toBeSummarizedMsgs.length;
          toBeSummarizedMsgs = toBeSummarizedMsgs.slice(
            Math.max(0, n - modelConfig.historyMessageCount),
          );
        }
        const memoryPrompt = get().getMemoryPrompt();
        if (memoryPrompt) {
          toBeSummarizedMsgs.unshift(memoryPrompt);
        }

        const lastSummarizeIndex = session.messages.length;

        console.log(
          "[Chat History] ",
          toBeSummarizedMsgs, // 这里的消息可能是 ChatMessage 格式
          historyMsgLength,
          modelConfig.compressMessageLengthThreshold,
        );

        if (
          historyMsgLength > modelConfig.compressMessageLengthThreshold &&
          modelConfig.sendMemory
        ) {
          const { max_tokens, ...modelcfg } = modelConfig;
              // --- 将 ChatMessage[] 转换为 RequestMessage[] 用于摘要 API ---
              // 选项 A: 假设摘要 API 只需要纯文本
              const finalSummarizeMessages: RequestMessage[] = toBeSummarizedMsgs.map(msg => ({
                role: msg.role,
                content: getMessageTextContent(msg), // 仅提取文本内容
              }));
              // 选项 B: 假设摘要 API 可以处理 MessageContent[]
              /*
              const finalSummarizeMessages: RequestMessage[] = toBeSummarizedMsgs.map(msg => ({
                role: msg.role,
                content: typeof msg.content === 'string'
                         ? msg.content // 或者包装: [{ type: 'text', text: msg.content }]
                         : msg.content, // 按原样传递数组
              }));
              */

          const summarizeSystemMessage: RequestMessage = { // 明确类型
            role: "system",
            content: Locale.Store.Prompt.Summarize,
            // date: "", // RequestMessage 没有 date 字段
          };

          api.llm.chat({
            messages: finalSummarizeMessages.concat(summarizeSystemMessage), // 使用转换后的数组
            config: {
              ...modelcfg,
              stream: true,
              model,
              providerName,
            },
            onUpdate(message) {
              session.memoryPrompt = message;
            },
            onFinish(message, responseRes) {
              if (responseRes?.status === 200) {
                console.log("[Memory] ", message);
                get().updateTargetSession(session, (session) => {
                  session.lastSummarizeIndex = lastSummarizeIndex;
                  session.memoryPrompt = message;
                });
              }
            },
            onError(err) {
              console.error("[Summarize] ", err);
            },
          });
        }
      },

updateStat(message: ChatMessage, session: ChatSession) {
  let charCount = 0;
  let tokenCount = 0; // 你可能也想计算这个

  if (typeof message.content === 'string') {
    charCount = message.content.length;
    tokenCount = estimateTokenLength(message.content);
  } else if (Array.isArray(message.content)) {
    message.content.forEach(part => {
      if (part.type === 'text') {
        charCount += part.text?.length ?? 0;
        tokenCount += estimateTokenLength(part.text ?? "");
      } else if (part.type === 'image_url') {
        // 决定如何计算图片/文件的字符/token
        // charCount += 0; // 或者计算 '[Image]'?
        tokenCount += 1000; // 一致的估算值
      } else if (part.type === 'file_url') {
        // charCount += `[File: ${part.file_url.name}]`.length; // 示例
        tokenCount += part.file_url.tokenCount ?? 50; // 一致的估算值
      }
    });
  }

  get().updateTargetSession(session, (session) => {
    session.stat.charCount += charCount;
    session.stat.tokenCount += tokenCount; // 更新 token 计数
    // TODO: 如果需要，更新 wordCount
  });
},


      updateTargetSession(
        targetSession: ChatSession,
        updater: (session: ChatSession) => void,
      ) {
        const sessions = get().sessions;
        const index = sessions.findIndex((s) => s.id === targetSession.id);
        if (index < 0) return;
        updater(sessions[index]);
        set(() => ({ sessions }));
      },

      async clearAllData() {
        await indexedDBStorage.clear();
        localStorage.clear();
        location.reload();
      },

      setLastInput(lastInput: string) {
        set({
          lastInput,
        });
      },

      checkMcpJson(message: ChatMessage) {
        const mcpEnabled = isMcpEnabled();
        if (!mcpEnabled) return;
        // !!! getMessageTextContent 需要能处理 content 数组 !!!
        const content = getMessageTextContent(message); // 假设 getMessageTextContent 已更新
        if (isMcpJson(content)) {
          try {
            const mcpRequest = extractMcpJson(content);
            if (mcpRequest) {
              console.debug("[MCP Request]", mcpRequest);

              executeMcpAction(mcpRequest.clientId, mcpRequest.mcp)
                .then((result) => {
                  console.log("[MCP Response]", result);
                  const mcpResponse =
                    typeof result === "object"
                      ? JSON.stringify(result)
                      : String(result);
                  // 调用 onUserInput 时，attachments 为空
                  get().onUserInput(
                    `\`\`\`json:mcp-response:${mcpRequest.clientId}\n${mcpResponse}\n\`\`\``,
                    [], // attachments 为空
                    true,
                  );
                })
                .catch((error) => showToast("MCP execution failed", error));
            }
          } catch (error) {
            console.error("[Check MCP JSON]", error);
          }
        }
      },

    }; // methods 结束

    return methods;
  },
  {
    name: StoreKey.Chat,
    version: 3.5, // 版本号可能需要增加
    // ... (migrate 函数保持不变，但要注意新版本可能需要新的迁移逻辑)
    migrate(persistedState, version) {
      const state = persistedState as any;
      const newState = JSON.parse(
        JSON.stringify(state),
      ) as typeof DEFAULT_CHAT_STATE;

      if (version < 2) {
        newState.sessions = [];

        const oldSessions = state.sessions;
        for (const oldSession of oldSessions) {
          const newSession = createEmptySession();
          newSession.topic = oldSession.topic;
          newSession.messages = [...oldSession.messages];
          newSession.mask.modelConfig.sendMemory = true;
          newSession.mask.modelConfig.historyMessageCount = 4;
          newSession.mask.modelConfig.compressMessageLengthThreshold = 1000;
          newState.sessions.push(newSession);
        }
      }

      if (version < 3) {
        // migrate id to nanoid
        newState.sessions.forEach((s) => {
          s.id = nanoid();
          s.messages.forEach((m) => (m.id = nanoid()));
        });
      }

      // Enable `enableInjectSystemPrompts` attribute for old sessions.
      // Resolve issue of old sessions not automatically enabling.
      if (version < 3.1) {
        newState.sessions.forEach((s) => {
          if (
            // Exclude those already set by user
            !s.mask.modelConfig.hasOwnProperty("enableInjectSystemPrompts")
          ) {
            // Because users may have changed this configuration,
            // the user's current configuration is used instead of the default
            const config = useAppConfig.getState();
            s.mask.modelConfig.enableInjectSystemPrompts =
              config.modelConfig.enableInjectSystemPrompts;
          }
        });
      }

      // add default summarize model for every session
      if (version < 3.2) {
        newState.sessions.forEach((s) => {
          const config = useAppConfig.getState();
          s.mask.modelConfig.compressModel = config.modelConfig.compressModel;
          s.mask.modelConfig.compressProviderName =
            config.modelConfig.compressProviderName;
        });
      }
      // revert default summarize model for every session
      if (version < 3.3) {
        newState.sessions.forEach((s) => {
          const config = useAppConfig.getState();
          s.mask.modelConfig.compressModel = "";
          s.mask.modelConfig.compressProviderName = "";
        });
      }

      if (version < 3.4) {
        newState.sessions.forEach((s) => {
          s.mask.plugin = s.mask.plugin ?? [];
        });
      }

      if (version < 3.5) { // 使用你在上面设置的新版本号
        newState.sessions.forEach(session => {
          session.messages.forEach(message => {
            // 检查 content 是否仍然是字符串 (来自旧版本)
            if (typeof message.content === 'string') {
              // 将字符串 content 包装到新的 MessageContent[] 结构中
              message.content = [{ type: 'text', text: message.content }];
            }
            // 如果 content 已经是数组 (例如，在开发期间)，它应该没问题。
            // 如果以前的开发版本有不同的数组结构，你可能需要在这里添加更多检查。
          });
        });
        console.log("Migrated chat store to version 3.4 (structured content)");
     }



      return newState as any;

      },
    },
  );
