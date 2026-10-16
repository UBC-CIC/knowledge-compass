import { useEffect, useRef, useCallback, useState } from "react";

import type { MessageSource } from "@/types/Chat";

export interface WebSocketMessage {
  type: "start" | "chunk" | "complete" | "error" | "pong";
  content?: string;
  response?: string;
  message?: string;
  error?: string;
  sources?: MessageSource[];
  warning?: string | null;
  phase?: "DETECTIVE" | "SUGGESTION" | null;
  session_name?: string;
  token_usage?: {
    remaining?: number;
    reset_at?: string;
  };
  // Sent with error DAILY_CHARACTER_LIMIT_EXCEEDED (per user, per UTC day).
  character_usage?: {
    used?: number;
    limit?: number;
    remaining?: number;
    reset_at?: string;
  };
}

/**
 * Offered with the access token as `new WebSocket(url, [WS_SUBPROTOCOL, token])`.
 * $connect verifies the token, binds the connection to its user and selects
 * this protocol; the token never goes in the URL.
 */
export const WS_SUBPROTOCOL = "kc.v1";

interface UseWebSocketOptions {
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
  /** Access token for the handshake; forceRefresh after a rejected handshake. */
  getToken: (forceRefresh: boolean) => Promise<string>;
  /** The user the socket is bound to; a change reconnects as the new user. */
  identity?: string | null;
}

export const useWebSocket = (
  url: string | null,
  options: UseWebSocketOptions
) => {
  const { identity } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isManualDisconnectRef = useRef(false);
  // scheduleReconnect is memoized with an empty deps array (its retry timer
  // must not reset every render), so it can't close over `connect` directly —
  // `connect` is recreated whenever `url` changes. Route through a ref that's
  // always kept current instead, so a reconnect always uses the latest URL.
  const connectRef = useRef<() => void>(() => {});
  // connect() awaits a token before creating the socket. connectingRef blocks
  // overlapping attempts; only disconnect() bumps connectGenerationRef, which
  // makes any in-flight attempt stale (it then touches nothing).
  const connectingRef = useRef(false);
  const connectGenerationRef = useRef(0);
  // Set when a handshake is refused (closed before open): the cached token is
  // bad, so the next attempt asks for a fresh one.
  const forceRefreshRef = useRef(false);
  const getTokenRef = useRef(options.getToken);
  getTokenRef.current = options.getToken;
  const identityRef = useRef<string | null | undefined>(undefined);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "disconnected" | "error"
  >("disconnected");

  // Store callbacks in refs to avoid dependency issues
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      window.clearInterval(heartbeatIntervalRef.current);
    }

    heartbeatIntervalRef.current = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({ type: "ping" }));
          console.log("[WebSocket] Sent ping");
        } catch (error) {
          console.error("[WebSocket] Error sending ping:", error);
        }
      }
    }, 30000);
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      window.clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (isManualDisconnectRef.current) {
      console.log("[WebSocket] Manual disconnect, not reconnecting");
      return;
    }

    if (reconnectAttemptsRef.current >= 10) {
      console.log("[WebSocket] Max reconnection attempts reached");
      setConnectionState("error");
      return;
    }

    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
    }

    const delay = Math.min(
      1000 * Math.pow(2, reconnectAttemptsRef.current),
      30000
    );
    console.log(
      `[WebSocket] Scheduling reconnect attempt ${
        reconnectAttemptsRef.current + 1
      }/10 in ${delay}ms`
    );

    reconnectTimeoutRef.current = window.setTimeout(() => {
      reconnectAttemptsRef.current++;
      connectRef.current();
    }, delay);
  }, []);

  const urlRef = useRef(url);
  urlRef.current = url;

  const connect = useCallback(async () => {
    if (
      !urlRef.current ||
      connectingRef.current ||
      wsRef.current?.readyState === WebSocket.CONNECTING ||
      wsRef.current?.readyState === WebSocket.OPEN
    ) {
      return;
    }
    const generation = connectGenerationRef.current; // read only; disconnect() increments
    connectingRef.current = true;
    setConnectionState("connecting");

    let token: string;
    try {
      token = await getTokenRef.current(forceRefreshRef.current);
    } catch {
      // Optional catch binding: an unused `error` fails @typescript-eslint/no-unused-vars.
      if (generation !== connectGenerationRef.current) return; // stale: touch nothing
      console.error("[WebSocket] Could not get a session token");
      connectingRef.current = false;
      setConnectionState("error");
      scheduleReconnect();
      return;
    }
    if (generation !== connectGenerationRef.current || isManualDisconnectRef.current) {
      // Stale or cancelled. disconnect() already cleared connectingRef for a stale
      // attempt; clear it only if this attempt still owns the current generation.
      if (generation === connectGenerationRef.current) connectingRef.current = false;
      return;
    }
    const currentUrl = urlRef.current;
    if (!currentUrl) {
      connectingRef.current = false;
      setConnectionState("disconnected");
      return;
    }
    forceRefreshRef.current = false;

    try {
      // Never log the token or the protocols array.
      const ws = new WebSocket(currentUrl, [WS_SUBPROTOCOL, token]);
      wsRef.current = ws;
      connectingRef.current = false;
      let opened = false;

      // Events from a socket that has since been replaced (or manually
      // closed) must not touch the shared refs/state; otherwise an old
      // socket's late onclose orphans the new one and every send falls back
      // to non-streaming HTTP.
      const isCurrent = () => wsRef.current === ws;

      ws.onopen = () => {
        opened = true;
        if (!isCurrent()) return;
        console.log("[WebSocket] Connected successfully");
        setConnectionState("connected");
        reconnectAttemptsRef.current = 0;
        startHeartbeat();
        callbacksRef.current.onConnect?.();
      };

      ws.onmessage = (event) => {
        try {
          if (typeof event.data === "string" && event.data.length > 1_000_000) {
            console.warn("[WebSocket] Received message string exceeds 1MB, ignoring");
            return;
          }

          const message: WebSocketMessage = JSON.parse(event.data);

          console.log("[WebSocket] Received message");

          if (message.type === "pong") {
            console.log("[WebSocket] Received pong");
            return;
          }

          callbacksRef.current.onMessage?.(message);
        } catch (error) {
          console.error("[WebSocket] Error parsing message:", error);
        }
      };

      ws.onclose = (event) => {
        console.log(
          `[WebSocket] Disconnected - Code: ${event.code}, Reason: ${event.reason}`
        );
        if (!isCurrent()) return;
        // Closed before it opened: the handshake was refused (e.g. an expired
        // or rotated token), so the next attempt fetches a fresh token.
        if (!opened) forceRefreshRef.current = true;

        wsRef.current = null;
        setConnectionState("disconnected");
        stopHeartbeat();
        callbacksRef.current.onDisconnect?.();

        // API Gateway closes idle/long-lived connections with 1001 (and can
        // use 1000), so any close we didn't ask for should reconnect.
        if (!isManualDisconnectRef.current) {
          console.log("[WebSocket] Unexpected closure, attempting to reconnect...");
          scheduleReconnect();
        }
      };

      ws.onerror = (error) => {
        if (!isCurrent()) return;
        console.error("[WebSocket] Connection error:", error);
        setConnectionState("error");
        callbacksRef.current.onError?.(error);
      };
    } catch (error) {
      console.error("[WebSocket] Error creating WebSocket:", error);
      connectingRef.current = false;
      setConnectionState("error");
      scheduleReconnect();
    }
  }, [startHeartbeat, stopHeartbeat, scheduleReconnect]);

  connectRef.current = connect;

  const disconnect = useCallback(() => {
    // Any in-flight connect() becomes stale and must not create a socket.
    connectGenerationRef.current += 1;
    connectingRef.current = false;
    console.log("[WebSocket] Manual disconnect requested");
    isManualDisconnectRef.current = true;

    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    stopHeartbeat();

    if (wsRef.current) {
      wsRef.current.close(1000, "Manual disconnect");
      wsRef.current = null;
    }

    setConnectionState("disconnected");
    reconnectAttemptsRef.current = 0;
  }, [stopHeartbeat]);

  const sendMessage = useCallback(
    (message: unknown) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try {
          const messageStr = JSON.stringify(message);
          console.log("[WebSocket] Sending message");
          wsRef.current.send(messageStr);
          return true;
        } catch (error) {
          console.error("[WebSocket] Error sending message:", error);
          return false;
        }
      }

      console.warn(
        `[WebSocket] Cannot send message - Connection state: ${connectionState}`
      );
      return false;
    },
    [connectionState]
  );

  const forceReconnect = useCallback(() => {
    console.log("[WebSocket] Force reconnect requested");
    isManualDisconnectRef.current = false;
    reconnectAttemptsRef.current = 0;

    disconnect();

    setTimeout(() => {
      isManualDisconnectRef.current = false;
      void connect();
    }, 1000);
  }, [disconnect, connect]);

  // Connect once a URL and identity are available. connect() is a no-op while a
  // socket is already open/connecting, so this does not interrupt streaming.
  useEffect(() => {
    const previous = identityRef.current;
    identityRef.current = identity;
    if (previous !== undefined && previous !== identity) {
      // Any identity change after mount: always disconnect. This closes a socket,
      // cancels an in-flight connect (generation bump), clears a pending reconnect
      // timer and resets the backoff counter, and is safe when none of those exist.
      disconnect();
    }
    if (url && identity) {
      isManualDisconnectRef.current = false;
      void connect();
    }
  }, [url, identity, connect, disconnect]);

  // Tear down only on unmount.
  useEffect(() => {
    return () => {
      isManualDisconnectRef.current = true;
      disconnect();
    };
  }, [disconnect]);

  // Derived from state so consumers re-render when the connection changes.
  const isConnected = connectionState === "connected";

  return {
    sendMessage,
    connect,
    disconnect,
    forceReconnect,
    isConnected,
    connectionState,
  };
};
