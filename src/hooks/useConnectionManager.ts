/**
 * useConnectionManager.ts — Production-Grade Socket Connection Manager
 *
 * Features:
 * 1. Auto-reconnect with exponential backoff
 * 2. Cold start warm-up (wakes Render before call)
 * 3. Health monitoring with ping/pong
 * 4. Connection state machine
 * 5. Pending message queue (survives disconnects)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

// Connection states
export type ConnectionState =
  | 'idle'
  | 'warming'      // Waking up cold server
  | 'connecting'
  | 'connected'
  | 'authenticated'
  | 'disconnected'
  | 'reconnecting'
  | 'failed';

export interface ConnectionConfig {
  serverUrl: string;
  nickname: 'Vishwa' | 'Ammu';
  callType: 'video' | 'voice';
  autoConnect?: boolean;
  warmOnMount?: boolean;
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
  healthCheckInterval?: number;
  healthCheckTimeout?: number;
}

export interface ConnectionManagerReturn {
  socket: Socket | null;
  state: ConnectionState;
  isHealthy: boolean;
  latency: number;
  connect: () => void;
  disconnect: () => void;
  reconnect: () => void;
  warmServer: () => Promise<boolean>;
  emitWithAck: <T>(event: string, data: any, timeout?: number) => Promise<T | null>;
  emitQueued: (event: string, data: any) => void;
}

// Default server URL
const DEFAULT_SERVER = 'https://camera-sharing-server.onrender.com';

export function useConnectionManager(config: ConnectionConfig): ConnectionManagerReturn {
  const {
    serverUrl = DEFAULT_SERVER,
    nickname,
    callType,
    autoConnect = true,
    warmOnMount = true,
    maxReconnectAttempts = 10,
    reconnectBaseDelay = 500,
    reconnectMaxDelay = 10000,
    healthCheckInterval = 15000,
    healthCheckTimeout = 5000,
  } = config;

  const [state, setState] = useState<ConnectionState>('idle');
  const [isHealthy, setIsHealthy] = useState(true);
  const [latency, setLatency] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const healthCheckTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const healthCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingSentAtRef = useRef<number>(0);
  const messageQueueRef = useRef<Array<{ event: string; data: any }>>([]);
  const isWarmingRef = useRef(false);
  const cancelledRef = useRef(false);
  const pendingAcksRef = useRef<Map<string, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>>(new Map());

  // ========================
  // SERVER WARM-UP
  // ========================

  const warmServer = useCallback(async (): Promise<boolean> => {
    if (isWarmingRef.current) {
      console.log('[Connection] Already warming...');
      return true;
    }

    isWarmingRef.current = true;
    setState('warming');
    console.log('[Connection] Warming up cold server...');

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

      const response = await fetch(`${serverUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        console.log('[Connection] Server is awake');
        isWarmingRef.current = false;
        return true;
      }

      throw new Error('Health check failed');
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.warn('[Connection] Warm-up timeout - server might be slow');
      } else {
        console.error('[Connection] Warm-up error:', err.message);
      }

      // Still return true - let connection attempt happen
      isWarmingRef.current = false;
      return true;
    }
  }, [serverUrl]);

  // ========================
  // HEALTH MONITORING
  // ========================

  const startHealthCheck = useCallback(() => {
    if (healthCheckTimerRef.current) {
      clearInterval(healthCheckTimerRef.current);
    }

    const sendPing = () => {
      if (!socketRef.current?.connected) return;

      pingSentAtRef.current = Date.now();
      socketRef.current.emit('ping', { ts: Date.now() });

      // Set pong timeout
      if (healthCheckTimeoutRef.current) {
        clearTimeout(healthCheckTimeoutRef.current);
      }

      healthCheckTimeoutRef.current = setTimeout(() => {
        console.warn('[Connection] Health check timeout - no pong received');
        setIsHealthy(false);
      }, healthCheckTimeout);
    };

    healthCheckTimerRef.current = setInterval(sendPing, healthCheckInterval);
    sendPing(); // Initial ping
  }, [healthCheckInterval, healthCheckTimeout]);

  const stopHealthCheck = useCallback(() => {
    if (healthCheckTimerRef.current) {
      clearInterval(healthCheckTimerRef.current);
      healthCheckTimerRef.current = null;
    }
    if (healthCheckTimeoutRef.current) {
      clearTimeout(healthCheckTimeoutRef.current);
      healthCheckTimeoutRef.current = null;
    }
  }, []);

  // ========================
  // RECONNECT WITH BACKOFF
  // ========================

  const scheduleReconnect = useCallback(() => {
    if (cancelledRef.current) return;

    const attempts = reconnectAttemptsRef.current;
    if (attempts >= maxReconnectAttempts) {
      console.error('[Connection] Max reconnect attempts reached');
      setState('failed');
      return;
    }

    // Exponential backoff with jitter
    const delay = Math.min(
      reconnectBaseDelay * Math.pow(2, attempts) + Math.random() * 100,
      reconnectMaxDelay
    );

    console.log(`[Connection] Reconnecting in ${Math.round(delay)}ms (attempt ${attempts + 1}/${maxReconnectAttempts})`);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectAttemptsRef.current++;
      setState('reconnecting');
      connect();
    }, delay);
  }, [maxReconnectAttempts, reconnectBaseDelay, reconnectMaxDelay]);

  // ========================
  // CONNECT
  // ========================

  const connect = useCallback(() => {
    if (socketRef.current?.connected) return;

    setState('connecting');

    const socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      reconnection: false, // We handle reconnection ourselves
      timeout: 20000,
      forceNew: true,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[Connection] Socket connected');
      setState('connected');
      reconnectAttemptsRef.current = 0;

      // Register user
      socket.emit('register', { user: nickname, callType });

      // Process queued messages
      while (messageQueueRef.current.length > 0) {
        const { event, data } = messageQueueRef.current.shift()!;
        socket.emit(event, data);
      }

      // Start health check
      startHealthCheck();
    });

    socket.on('registered', (data) => {
      console.log('[Connection] Registered:', data);
      setState('authenticated');
      setIsHealthy(true);
    });

    socket.on('disconnect', (reason) => {
      console.log('[Connection] Disconnected:', reason);
      stopHealthCheck();
      setState('disconnected');
      setIsHealthy(false);

      if (!cancelledRef.current && reason !== 'io client disconnect') {
        scheduleReconnect();
      }
    });

    socket.on('connect_error', (err) => {
      console.error('[Connection] Connect error:', err.message);
      stopHealthCheck();

      if (!cancelledRef.current) {
        scheduleReconnect();
      }
    });

    // Pong handler
    socket.on('pong', (data) => {
      if (healthCheckTimeoutRef.current) {
        clearTimeout(healthCheckTimeoutRef.current);
      }

      const currentLatency = Date.now() - pingSentAtRef.current;
      setLatency(currentLatency);
      setIsHealthy(true);

      console.log(`[Connection] Pong received, latency: ${currentLatency}ms`);
    });

    // Health warning handler
    socket.on('health-warning', (data) => {
      console.warn('[Connection] Health warning:', data.reason);
      setIsHealthy(false);
    });
  }, [serverUrl, nickname, callType, startHealthCheck, stopHealthCheck, scheduleReconnect]);

  // ========================
  // DISCONNECT
  // ========================

  const disconnect = useCallback(() => {
    cancelledRef.current = true;

    // Clear all timers
    stopHealthCheck();
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // Clear pending acks
    pendingAcksRef.current.forEach((handler, id) => {
      clearTimeout(handler.timer);
      handler.reject(new Error('Disconnected'));
    });
    pendingAcksRef.current.clear();

    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    setState('idle');
    reconnectAttemptsRef.current = 0;
  }, [stopHealthCheck]);

  // ========================
  // RECONNECT
  // ========================

  const reconnect = useCallback(() => {
    disconnect();
    cancelledRef.current = false;
    reconnectAttemptsRef.current = 0;
    connect();
  }, [disconnect, connect]);

  // ========================
  // EMIT WITH ACK (reliable)
  // ========================

  const emitWithAck = useCallback(async <T,>(
    event: string,
    data: any,
    timeout = 10000
  ): Promise<T | null> => {
    return new Promise((resolve) => {
      if (!socketRef.current?.connected) {
        console.warn(`[Connection] Cannot emit "${event}" - not connected`);
        resolve(null);
        return;
      }

      const ackId = `${event}_${Date.now()}`;

      const timer = setTimeout(() => {
        pendingAcksRef.current.delete(ackId);
        console.warn(`[Connection] Ack timeout for "${event}"`);
        resolve(null);
      }, timeout);

      pendingAcksRef.current.set(ackId, {
        resolve: (result: T) => {
          clearTimeout(timer);
          pendingAcksRef.current.delete(ackId);
          resolve(result);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          pendingAcksRef.current.delete(ackId);
          resolve(null);
        },
        timer,
      });

      socketRef.current.emit(event, data, (response: T) => {
        const handler = pendingAcksRef.current.get(ackId);
        if (handler) {
          handler.resolve(response);
        }
      });
    });
  }, []);

  // ========================
  // EMIT QUEUED (survives disconnect)
  // ========================

  const emitQueued = useCallback((event: string, data: any) => {
    if (socketRef.current?.connected && state === 'authenticated') {
      socketRef.current.emit(event, data);
    } else {
      console.log(`[Connection] Queuing "${event}" for later`);
      messageQueueRef.current.push({ event, data });
    }
  }, [state]);

  // ========================
  // EFFECTS
  // ========================

  useEffect(() => {
    cancelledRef.current = false;

    // Warm server on mount if enabled
    if (warmOnMount) {
      warmServer().then(() => {
        if (autoConnect && !cancelledRef.current) {
          connect();
        }
      });
    } else if (autoConnect) {
      connect();
    }

    return () => {
      cancelledRef.current = true;
      disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      messageQueueRef.current = [];
    };
  }, []);

  return {
    socket: socketRef.current,
    state,
    isHealthy,
    latency,
    connect,
    disconnect,
    reconnect,
    warmServer,
    emitWithAck,
    emitQueued,
  };
}
