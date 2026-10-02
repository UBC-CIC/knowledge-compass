import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { detectPII } from "@coffeeandfun/remove-pii";
import { useNavigate } from "react-router";

import AIChatMessage from "@/components/ChatInterface/AIChatMessage";
import UserChatMessage from "@/components/ChatInterface/UserChatMessage";
import { useView } from "@/providers/view";
import { AiChatInput } from "@/components/ChatInterface/userInput";
import { useWebSocket } from "@/hooks/useWebSocket";
import type { Message } from "@/types/Chat";
import { useUser } from "@/providers/user";
import DemoGuidanceCard from "@/components/ChatInterface/DemoGuidanceCard";
import ConversationFeedback from "@/components/ChatInterface/ConversationFeedback";
import { useSessionFeedback } from "@/hooks/useSessionFeedback";
import {
  applyDemoFact,
  getDemoSessionState,
  isDemoMode,
  nextDemoReply,
  setDemoSessionState,
  type DemoFacts,
} from "@/lib/demo";

type MaxCharactersResponse = {
  max_characters_per_user_message?: number;
};

const DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE = 50000;

// Legacy (pre-Inclusion Canada) auto-sent opener. No longer sent; kept verbatim
// only so older chat histories that start with it hide that first message.
// Do not edit the text or the match will stop working.
const LEGACY_WELCOME_PROMPT = `Hello! Please act as the Specialization Explorer.
1. Introduce yourself briefly.
2. Ask the student these 1 of these starter questions, and use some variation of these in the later responses to complete the checklist:
   - What are your academic interests?
   - Which course or department do you like most at UBC Science?
   - Do you want to pursue research or enter industry after graduation?
3. Be friendly and inviting.`;

const WELCOME_STARTERS = [
  {
    tag: "Right now",
    text: "My child keeps getting sent home before lunch",
    hint: "The school says they can't support my child all day",
  },
  {
    tag: "Right now",
    text: "My child is being left out of field trips and activities",
    hint: "Exclusion from parts of the school day",
  },
  {
    tag: "Planning",
    text: "We're getting ready for the move to high school",
    hint: "Transitions, courses, and support planning",
  },
];

const WELCOME_HEADING =
  "Hi, I'm here to help you navigate your child's education.";
const WELCOME_ASK =
  "Tell me what's been happening. What's going on with your child's schooling right now?";
const DEFAULT_WELCOME_MESSAGE =
  "Whether your child is being sent home early or excluded from school activities, or you're planning for their future, you don't have to figure this out alone.";
const DEFAULT_DISCLAIMER =
  "Knowledge Compass shares information from Inclusion Canada's reviewed guidance. It isn't legal advice, and it can make mistakes.";

function welcomeBody(message: string): string {
  let text = message.trim();
  for (const chrome of [WELCOME_HEADING, WELCOME_ASK]) {
    text = text.split(chrome).join("");
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

type AIChatPageProps = {
  welcomeMessage?: string;
  disclaimer?: string;
  isLoadingWelcome?: boolean;
};

export default function AIChatPage({
  welcomeMessage = DEFAULT_WELCOME_MESSAGE,
  disclaimer = DEFAULT_DISCLAIMER,
  isLoadingWelcome = false,
}: AIChatPageProps) {
  const { setCurrentMessages, setActiveChatName, setConversationFacts } = useView();
  const navigate = useNavigate();

  // State
  const skipNextHistoryLoadRef = useRef(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [initialMessageLoadTime, setInitialMessageLoadTime] = useState<
    number | null
  >(null);

  const {
    activeChatSessionId,
    chatSessions,
    updateChatSessionName,
    createNewChatSession,
  } = useView();
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  // Id of the bot placeholder currently receiving streamed output. Kept in a
  // ref (not state) so WebSocket events always see the value set by
  // sendMessage, even if a render/effect for a session change happens in
  // between (e.g. when the first message creates a new session).
  const streamingMessageIdRef = useRef<string | null>(null);

  const [isTokenLimitReached, setIsTokenLimitReached] = useState(false);
  const [tokenResetTime, setTokenResetTime] = useState<string | null>(null);

  const [maxCharactersPerUserMessage, setMaxCharactersPerUserMessage] = useState(
    DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE
  );

  const formatResetTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return null;
    }
  };

  const { userId } = useUser();
  const sessionFeedback = useSessionFeedback(activeChatSessionId, userId);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const demoAskedRef = useRef(0);
  const demoFactsRef = useRef<DemoFacts>({});

  const activeChatNameDisplay = useMemo(() => {
    if (!activeChatSessionId) {
      return null;
    }

    const activeIndex = chatSessions.findIndex(
      (session) => session.id === activeChatSessionId
    );

    if (activeIndex === -1) {
      return null;
    }

    const activeSession = chatSessions[activeIndex];
    if (activeSession.name?.trim()) {
      return activeSession.name;
    }

    // Match the same fallback label shown in the sidebar.
    return `Chat ${chatSessions.length - activeIndex}`;
  }, [activeChatSessionId, chatSessions]);

  // Update context with current messages and chat name
  useEffect(() => {
    setCurrentMessages(messages);
    setActiveChatName(activeChatNameDisplay);
  }, [messages, activeChatNameDisplay, setCurrentMessages, setActiveChatName]);

  // Auto-scroll to bottom when messages change or when typing starts
  const scrollToBottom = useCallback(() => {
    // "end" aligns the bottom of the element with the bottom of the scrollable area
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Capture the initial messages load time to avoid autoplaying historical messages
  useEffect(() => {
    if (!isLoadingHistory && initialMessageLoadTime === null) {
      setInitialMessageLoadTime(Date.now());
    }
  }, [isLoadingHistory, initialMessageLoadTime]);

  const [webSocketToken, setWebSocketToken] = useState<string | null>(null);

  // WebSocket configuration
  const baseWebSocketUrl = useMemo(
    () => import.meta.env.VITE_WEBSOCKET_URL,
    []
  );
  const webSocketUrl = useMemo(() => {
    if (!baseWebSocketUrl || !webSocketToken) {
      return null;
    }

    try {
      const url = new URL(baseWebSocketUrl);
      url.searchParams.set("token", webSocketToken);
      return url.toString();
    } catch (error) {
      console.error("[WebSocket] Invalid base URL:", error);
      return null;
    }
  }, [baseWebSocketUrl, webSocketToken]);

  useEffect(() => {
    if (!baseWebSocketUrl) {
      console.warn("[WebSocket] Base URL not configured");
      return;
    }
  }, [baseWebSocketUrl, webSocketToken]);

  useEffect(() => {
    const apiEndpoint = import.meta.env.VITE_API_ENDPOINT;
    if (isDemoMode || !apiEndpoint) {
      return;
    }

    let isActive = true;
    let refreshTimeoutId: number | undefined;
    const refreshDelayMs = 14 * 60 * 1000;
    const retryDelayMs = 30 * 1000;

    async function fetchToken() {
      if (!isActive) {
        return;
      }

      try {
        const response = await fetch(`${apiEndpoint}/user/publicToken`);
        if (!response.ok) {
          throw new Error(
            `Token request failed with status ${response.status}`
          );
        }

        const { token } = await response.json();
        if (!isActive) {
          return;
        }

        setWebSocketToken(token);
        scheduleNext(refreshDelayMs);
      } catch (error) {
        console.error("[WebSocket] Failed to fetch streaming token:", error);
        if (!isActive) {
          return;
        }

        setWebSocketToken(null);
        scheduleNext(retryDelayMs);
      }
    }

    function scheduleNext(delay: number) {
      if (!isActive) {
        return;
      }

      if (refreshTimeoutId !== undefined) {
        window.clearTimeout(refreshTimeoutId);
      }

      refreshTimeoutId = window.setTimeout(
        fetchToken,
        delay
      ) as unknown as number;
    }

    fetchToken();

    return () => {
      isActive = false;
      if (refreshTimeoutId !== undefined) {
        window.clearTimeout(refreshTimeoutId);
      }
    };
  }, []);

  // WebSocket message handlers - memoized to prevent unnecessary reconnections
  const handleWebSocketMessage = useCallback(
    (message: any) => {
      const streamingMessageId = streamingMessageIdRef.current;

      switch (message.type) {
        case "start":
          setIsStreaming(true);
          // Update the streaming message to show typing indicator
          if (streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId ? { ...msg, isTyping: true } : msg
              )
            );
          }
          break;

        case "chunk":
          if (message.content && streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId
                  ? {
                      ...msg,
                      text: msg.text + message.content,
                      isTyping: false,
                    }
                  : msg
              )
            );
          }
          break;

        case "complete":
          setIsStreaming(false);
          streamingMessageIdRef.current = null;
          if (streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId
                  ? {
                      ...msg,
                      text:
                        message.response ||
                        message.content ||
                        msg.text,
                      sources_used: message.sources || [],
                      warning: message.warning || null,
                      phase: message.phase || null,
                      isTyping: false,
                    }
                  : msg
              )
            );
          }
          // Handle session name update
          if (message.session_name && activeChatSessionId) {
            updateChatSessionName(activeChatSessionId, message.session_name);
          }
          if (message.token_usage?.remaining === 0) {
            setIsTokenLimitReached(true);
            if (message.token_usage.reset_at) {
              setTokenResetTime(formatResetTime(message.token_usage.reset_at));
            }
          }
          break;

        case "error":
          setIsStreaming(false);
          streamingMessageIdRef.current = null;
          if (message.error === 'TOKEN_LIMIT_EXCEEDED') {
            setIsTokenLimitReached(true);
            if (message.token_usage?.reset_at) {
              setTokenResetTime(formatResetTime(message.token_usage.reset_at));
            }
          }
          if (streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId
                  ? {
                      ...msg,
                      text: message.message || "An error occurred",
                      isTyping: false,
                    }
                  : msg
              )
            );
          }
          break;
      }
    },
    [activeChatSessionId, updateChatSessionName]
  );

  const {
    sendMessage: sendWebSocketMessage,
    isConnected,
    connectionState,
    forceReconnect,
  } = useWebSocket(webSocketUrl, {
    onMessage: handleWebSocketMessage,
    onConnect: () => {
      console.log("[WebSocket] Connected");
      console.log("Streaming: ", isStreaming);
    },
    onDisconnect: () => {
      console.log("[WebSocket] Disconnected");
      console.log("Streaming: ", isStreaming);
    },
    onError: (error) => {
      console.error("[WebSocket] Error:", error);
      console.log("Streaming: ", isStreaming);
    },
  });

  const fetchMaxCharactersPerUserMessage = async () => {
    try {
      const tokenResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
      );
      if (!tokenResponse.ok) {
        throw new Error("Failed to get public token");
      }

      const { token } = await tokenResponse.json();

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/system-settings/max-characters-per-user-message`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch max_characters_per_user_message");
      }

      const data: MaxCharactersResponse = await response.json();

      setMaxCharactersPerUserMessage(
        data.max_characters_per_user_message ??
          DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE
      );
    } catch (error) {
      console.error("Failed to fetch max user message length:", error);
      setMaxCharactersPerUserMessage(DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE);
    }
  };

  useEffect(() => {
    if (isDemoMode) {
      return;
    }
    fetchMaxCharactersPerUserMessage();
  }, []);

  useEffect(() => {
    // The first message of a new chat creates the session itself. That
    // session change must not wipe the stream that sendMessage just started,
    // and there is no history to load yet.
    if (activeChatSessionId && skipNextHistoryLoadRef.current) {
      skipNextHistoryLoadRef.current = false;
      setIsLoadingHistory(false);
      return;
    }

    // Any other session switch invalidates an in-flight stream from the
    // previous session; otherwise the composer can stay disabled forever if
    // the old session's "complete"/"error" event never matches up with the
    // newly displayed messages.
    setIsStreaming(false);
    streamingMessageIdRef.current = null;

    if (!activeChatSessionId) {
      setMessages([]);
      setIsLoadingHistory(false);
      demoAskedRef.current = 0;
      demoFactsRef.current = {};
      setConversationFacts({});
      return;
    }

    if (isDemoMode) {
      const stored = getDemoSessionState(activeChatSessionId);
      setMessages(stored?.messages ?? []);
      demoAskedRef.current = stored?.asked ?? 0;
      demoFactsRef.current = stored?.facts ?? {};
      setConversationFacts(stored?.facts ?? {});
      setIsLoadingHistory(false);
      return;
    }

    // Guards against a slower earlier request (e.g. from a session the user
    // has since navigated away from) overwriting a faster later one.
    let isActive = true;

    const loadChatHistory = async () => {
      setIsLoadingHistory(true);
      try {
        // Get public token
        const tokenResponse = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
        );
        if (!tokenResponse.ok) throw new Error("Failed to get public token");
        const { token } = await tokenResponse.json();

        const response = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/user/${userId}/chat_sessions/${activeChatSessionId}/chat_history`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) throw new Error("Failed to load chat history");

        interface ChatMessageRow {
          id: string;
          chat_session_id: string;
          sender: "user" | "AI";
          content: string;
          sources?: any; // jsonb
          warning?: string | null;
          created_at: string; // ISO
        }

        const data: { messages: ChatMessageRow[] } = await response.json();

        const rawMessages = data.messages || [];
        // Hide the legacy auto-sent opener in older sessions.
        const startIndex = (rawMessages.length > 0 && rawMessages[0].content === LEGACY_WELCOME_PROMPT) ? 1 : 0;

        const chatMessages: Message[] = rawMessages.slice(startIndex).map((m) => {
          let parsedSources: any[] = [];
          if (m.sender === "AI" && m.sources) {
            if (Array.isArray(m.sources)) {
              parsedSources = m.sources;
            } else if (typeof m.sources === "string") {
              try {
                const parsed = JSON.parse(m.sources);
                parsedSources = Array.isArray(parsed) ? parsed : [parsed];
              } catch {
                parsedSources = [m.sources];
              }
            } else {
              parsedSources = [m.sources];
            }
          }

          return {
            id: m.id,
            sender: m.sender === "AI" ? ("bot" as const) : ("user" as const),
            text: m.content,
            sources_used: parsedSources,
            warning: (m as any).warning ?? null,
            phase: parsedSources.length > 0 ? "SUGGESTION" : "DETECTIVE",
            time: new Date(m.created_at).getTime(),
          };
        });

        // Ensure order (backend already orders, but safe)
        chatMessages.sort((a, b) => a.time - b.time);

        if (!isActive) return;
        setMessages(chatMessages);
      } catch (error) {
        if (!isActive) return;
        console.error("Failed to load chat history:", error);
      } finally {
        if (isActive) setIsLoadingHistory(false);
      }
    };

    loadChatHistory();

    return () => {
      isActive = false;
    };
  }, [activeChatSessionId, userId]);

  async function sendMessage(textOverride?: string) {
    if (isStreaming) return;

    let text = (textOverride ?? message).trim();
    if (!text) return;

    let sessionId = activeChatSessionId;
    if (!sessionId) {
      skipNextHistoryLoadRef.current = true;
      const session = await createNewChatSession();
      if (!session) {
        skipNextHistoryLoadRef.current = false;
        return;
      }
      sessionId = session.id;
      navigate("/chat");
    }

    if (isDemoMode) {
      const asked = demoAskedRef.current;
      const facts = applyDemoFact(demoFactsRef.current, asked, text);
      const reply = nextDemoReply(asked);

      const userMsg: Message = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        sender: "user",
        text,
        time: Date.now(),
      };

      const botMsg: Message = {
        id: `${Date.now() + 1}-${Math.random().toString(36).slice(2, 9)}`,
        sender: "bot",
        text: "",
        time: Date.now() + 1,
        isTyping: true,
      };

      setMessages((prev) => [...prev, userMsg, botMsg]);
      streamingMessageIdRef.current = botMsg.id;
      setIsStreaming(true);
      setMessage("");

      window.setTimeout(() => {
        const finished: Message = {
          ...botMsg,
          text: reply.text,
          question: reply.question,
          chips: reply.chips,
          showGuidance: reply.showGuidance,
          phase: reply.phase,
          isTyping: false,
        };

        // Advance facts/progress here, in step with the bot's next question
        // actually appearing — advancing them at send time (before the bot's
        // typing delay finishes) made the progress bar jump ahead of what's
        // on screen, looking like it skipped a question.
        demoFactsRef.current = facts;
        setConversationFacts(facts);

        if (asked === 0 && facts.situation) {
          updateChatSessionName(sessionId, facts.situation.slice(0, 80));
        }

        setMessages((prev) => {
          const next = prev.map((msg) => (msg.id === botMsg.id ? finished : msg));
          demoAskedRef.current = reply.asked;
          setDemoSessionState(sessionId, {
            messages: next,
            facts,
            asked: reply.asked,
            showGuidance: reply.showGuidance,
          });
          return next;
        });
        setIsStreaming(false);
        streamingMessageIdRef.current = null;
      }, 750);
      return;
    }

    // Create user message for AI generation
    const userMsg: Message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      sender: "user",
      text,
      time: Date.now(),
      hasPII: detectPII(text).hasPII,
    };

    // Create bot message placeholder for streaming
    const botMsg: Message = {
      id: `${Date.now() + 1}-${Math.random().toString(36).slice(2, 9)}`,
      sender: "bot",
      text: "",
      sources_used: [],
      time: Date.now() + 1,
      isTyping: true, // Start with typing indicator
    };

    // Add user and bot messages
    setMessages((m) => [...m, userMsg, botMsg]);
    streamingMessageIdRef.current = botMsg.id;
    setIsStreaming(true);

    // Clear the input box text immediately 
    setMessage("");

    // Try WebSocket streaming first, fallback to HTTP if not connected
    if (isConnected) {
      
      const success = sendWebSocketMessage({
        action: "generate_text",
        query: text,
        chat_session_id: sessionId,
        user_id: userId,
      });

      if (success) {
        console.log("[WebSocket] Message sent successfully.");
        return;
      } else {
        console.warn(
          "[WebSocket] Message send failed. Attempting reconnect..."
        );
        forceReconnect();
      }
    } else {
      console.warn(
        `[WebSocket] Not connected (state: ${connectionState}). Falling back to HTTP.`
      );
    }

    // Fallback to HTTP API if WebSocket is not available
    console.log("[WebSocket] Fallback: Sending message via HTTP API...");

    // Show typing indicator for HTTP fallback
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === botMsg.id ? { ...msg, isTyping: true } : msg
      )
    );

    try {
      // Get fresh token for the request
      const tokenResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
      );
      const { token } = await tokenResponse.json();
      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT
        }/chat_sessions/${sessionId}/text_generation`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            query: text,
            chat_session_id: sessionId,
            user_id: userId,
          }),
        }
      );

      if (!response.ok) {
        if (response.status === 429) {
          const errData = await response.json();
          if (errData.error === "TOKEN_LIMIT_EXCEEDED") {
            setIsTokenLimitReached(true);
            if (errData.token_usage?.reset_at) {
              setTokenResetTime(formatResetTime(errData.token_usage.reset_at));
            }
            throw new Error(errData.message || "Token limit exceeded");
          }
        }
        throw new Error("Failed to generate response");
      }

      const data = await response.json();

      if (data.token_usage?.remaining === 0) {
        setIsTokenLimitReached(true);
        if (data.token_usage.reset_at) {
          setTokenResetTime(formatResetTime(data.token_usage.reset_at));
        }
      }

      // Update the bot message with the complete response
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === botMsg.id
            ? {
                ...msg,
                text: data.response || "Sorry, I couldn't generate a response.",
                sources_used: data.sources || [],
                warning: data.warning || null,
                phase: data.phase || null,
                isTyping: false,
              }
            : msg
        )
      );

      // Handle session name update for HTTP fallback
      if (data.session_name && sessionId) {
        updateChatSessionName(sessionId, data.session_name);
      }
    } catch (error) {
      console.error("Error generating text:", error);
      // Update the bot message with error
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === botMsg.id
            ? {
                ...msg,
                text: "Sorry, there was an error processing your request.",
                isTyping: false,
              }
            : msg
        )
      );
    } finally {
      setIsStreaming(false);
      streamingMessageIdRef.current = null;
    }
  }



  function messageFormatter(message: Message) {
    if (message.sender === "user") {
      return (
        <UserChatMessage
          key={message.id}
          text={message.text}
          hasPII={message.hasPII}
        />
      );
    } else {
    return (
      <AIChatMessage
        key={message.id}
        text={message.text}
        question={message.question}
        sources={message.sources_used}
        warning={message.warning}
        isTyping={message.isTyping}
        phase={message.phase}
        footer={
          showFeedback && message.id === lastBotMessage?.id ? (
            <ConversationFeedback
              feedback={sessionFeedback.feedback}
              isSaving={sessionFeedback.isSaving}
              error={sessionFeedback.error}
              onSave={sessionFeedback.saveFeedback}
            />
          ) : null
        }
      />
    );
    }
  }

  const isWelcome = !activeChatSessionId;
  const lastBotMessage = [...messages].reverse().find((m) => m.sender === "bot");
  // Feedback is per conversation and sits under the latest finished reply.
  const showFeedback =
    Boolean(activeChatSessionId) &&
    !isStreaming &&
    !sessionFeedback.isLoading &&
    Boolean(lastBotMessage && !lastBotMessage.isTyping && lastBotMessage.text.trim());
  const demoChips =
    isDemoMode && !isStreaming && lastBotMessage?.chips?.length
      ? lastBotMessage.chips
      : [];
  const showDemoGuidance =
    isDemoMode && !isStreaming && Boolean(lastBotMessage?.showGuidance);


  const handleKeepGoing = () => {
    setMessages((prev) => {
      const next = prev.map((msg) =>
        msg.showGuidance ? { ...msg, showGuidance: false } : msg
      );
      if (activeChatSessionId) {
        setDemoSessionState(activeChatSessionId, {
          messages: next,
          facts: demoFactsRef.current,
          asked: demoAskedRef.current,
          showGuidance: false,
        });
      }
      return next;
    });
  };

  const displayedWelcome = isLoadingWelcome
    ? "Loading..."
    : welcomeBody(welcomeMessage);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain chat-scrollbar w-full px-4 md:px-[34px]">
        <div className="mx-auto w-full max-w-[680px] py-10 pb-6">
          {isWelcome ? (
            <div>
              <h1 className="font-serif text-[40px] font-semibold leading-[1.16] tracking-[-0.015em] text-pretty">
                {WELCOME_HEADING}
              </h1>
              {displayedWelcome ? (
                <p className="mt-4 text-[17.5px] leading-[1.62] text-foreground/80 text-pretty whitespace-pre-line">
                  {displayedWelcome}
                </p>
              ) : null}
              <p className="mt-3.5 text-[17.5px] font-semibold leading-relaxed text-pretty">
                {WELCOME_ASK}
              </p>

              <div className="mt-[26px] text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/70">
                Or start from a situation like yours
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {WELCOME_STARTERS.map((starter) => (
                  <button
                    key={starter.text}
                    type="button"
                    onClick={() => void sendMessage(starter.text)}
                    className="flex items-start gap-3.5 rounded-[10px] border border-foreground/14 bg-white px-[17px] py-[15px] text-left hover:border-primary hover:bg-accent"
                  >
                    <span className="mt-px shrink-0 rounded-md bg-secondary px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.03em] text-secondary-foreground">
                      {starter.tag}
                    </span>
                    <span>
                      <span className="block text-[15.5px] font-semibold leading-snug">
                        {starter.text}
                      </span>
                      <span className="mt-0.5 block text-[13.5px] leading-normal text-foreground/80">
                        {starter.hint}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {isLoadingHistory ? (
                <p className="py-8 text-[14.5px] text-foreground/70">Loading chat history...</p>
              ) : (
                <>
                  {messages.map((m) => messageFormatter(m))}
                  {demoChips.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {demoChips.map((chip) => (
                        <button
                          key={chip}
                          type="button"
                          onClick={() => void sendMessage(chip)}
                          className="min-h-11 rounded-[9px] border border-foreground/20 bg-white px-[15px] text-[14.5px] font-medium hover:border-primary hover:bg-accent"
                        >
                          {chip}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {showDemoGuidance ? (
                    <DemoGuidanceCard onKeepGoing={handleKeepGoing} />
                  ) : null}
                  <div ref={messagesEndRef} className="h-1 shrink-0" />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-4 pb-[18px] pt-3 md:px-[34px]">
        <div className="mx-auto w-full max-w-[680px]">
          <AiChatInput
            value={message}
            onChange={(val: string) => setMessage(val)}
            maxLength={maxCharactersPerUserMessage}
            placeholder={
              isTokenLimitReached
                ? `Daily limit reached. Resets at ${tokenResetTime || "soon"}`
                : isStreaming
                ? "Thinking about what you've told me…"
                : "Write what's happening in your own words…"
            }
            onSend={() => void sendMessage()}
            disabled={isTokenLimitReached || isStreaming}
          />
          <p className="mt-2 text-xs leading-normal text-foreground/75">
            {disclaimer}
          </p>
        </div>
      </div>
    </div>
  );
}
