import { useEffect, useRef, useCallback, useState } from "react";

interface WebSocketMessage {
  type: "start" | "chunk" | "complete" | "error" | "pong";
  content?: string;
  message?: string;
  sources?: string[];
  warning?: string | null;
  phase?: "DETECTIVE" | "SUGGESTION" | null;
}

interface UseWebSocketOptions {
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
}

export const useWebSocket = (
  url: string | null,
  options: UseWebSocketOptions = {}
) => {
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

  // The URL carries a short-lived auth token that rotates periodically. The
  // token is only checked on $connect, so keep the latest URL in a ref for
  // (re)connects instead of tearing down a healthy socket on every rotation,
  // which would drop any response being streamed on the old connection.
  const urlRef = useRef(url);
  urlRef.current = url;

  const connect = useCallback(() => {
    const currentUrl = urlRef.current;
    if (
      !currentUrl ||
      wsRef.current?.readyState === WebSocket.CONNECTING ||
      wsRef.current?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    setConnectionState("connecting");

    try {
      const ws = new WebSocket(currentUrl);
      wsRef.current = ws;

      // Events from a socket that has since been replaced (or manually
      // closed) must not touch the shared refs/state; otherwise an old
      // socket's late onclose orphans the new one and every send falls back
      // to non-streaming HTTP.
      const isCurrent = () => wsRef.current === ws;

      ws.onopen = () => {
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
      setConnectionState("error");
      scheduleReconnect();
    }
  }, [startHeartbeat, stopHeartbeat, scheduleReconnect]);

  connectRef.current = connect;

  const disconnect = useCallback(() => {
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
    (message: any) => {
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
      connect();
    }, 1000);
  }, [disconnect, connect]);

  // Connect once a URL is available. connect() is a no-op while a socket is
  // already open/connecting, so token rotations don't interrupt streaming;
  // the new URL is picked up on the next reconnect via urlRef.
  useEffect(() => {
    if (url) {
      isManualDisconnectRef.current = false;
      connect();
    }
  }, [url, connect]);

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
