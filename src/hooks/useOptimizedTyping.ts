/**
 * useOptimizedTyping.ts — Fixed v3
 *
 * Root cause of lag: Singleton shared socket was handling BOTH send + receive
 * on the same connection, blocking the UI thread during typing.
 *
 * Fix:
 *  - Two separate lightweight sockets (sender + listener)
 *  - Aggressive socket config: no polling fallback, instant timeout
 *  - Typing state update is purely local (no await, no async) = zero lag
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';

const SIGNALING_SERVER = 'https://camera-sharing-server.onrender.com';

// ── Sender hook: useOptimizedTyping ──────────────────────────────────────────
export function useOptimizedTyping(
  nickname: string,
  chatId: string = 'privateMessages',
  enabled: boolean = true
) {
  const socketRef = useRef<Socket | null>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTypingRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const socket = io(SIGNALING_SERVER, {
      transports: ['websocket'], // websocket only — no polling fallback (polling causes lag)
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 500,   // faster reconnect
      timeout: 5000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('register', { user: nickname, callType: 'typing' });
    });

    socket.on('disconnect', () => {
      isTypingRef.current = false;
    });

    return () => {
      if (isTypingRef.current && socket.connected) {
        socket.emit('typing-stop', { chatId, user: nickname });
      }
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [nickname, chatId, enabled]);

  const handleTyping = useCallback(() => {
    if (!enabled) return;

    const socket = socketRef.current;
    if (!socket?.connected) return;

    // Send typing-start only once per typing burst
    if (!isTypingRef.current) {
      socket.emit('typing-start', { chatId, user: nickname });
      isTypingRef.current = true;
    }

    // Reset auto-stop timer on every keystroke
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

    typingTimeoutRef.current = setTimeout(() => {
      if (socket.connected && isTypingRef.current) {
        socket.emit('typing-stop', { chatId, user: nickname });
        isTypingRef.current = false;
      }
    }, 2000);
  }, [nickname, chatId, enabled]);

  const stopTyping = useCallback(() => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    const socket = socketRef.current;
    if (socket?.connected && isTypingRef.current) {
      socket.emit('typing-stop', { chatId, user: nickname });
      isTypingRef.current = false;
    }
  }, [nickname, chatId]);

  return { handleTyping, stopTyping };
}

// ── Listener hook: useTypingListener ─────────────────────────────────────────
export function useTypingListener(
  otherUser: 'Vishwa' | 'Ammu',
  chatId: string = 'privateMessages',
  enabled: boolean = true
) {
  const [isOtherUserTyping, setIsOtherUserTyping] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const clearTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const socket = io(SIGNALING_SERVER, {
      transports: ['websocket'], // websocket only — no polling fallback
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 500,
      timeout: 5000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      // Register as the CURRENT user (opposite of otherUser)
      const currentUser = otherUser === 'Vishwa' ? 'Ammu' : 'Vishwa';
      socket.emit('register', { user: currentUser, callType: 'typing-listener' });
    });

    socket.on('typing-update', (data: {
      user: string;
      isTyping: boolean;
      chatId: string;
      timestamp: number;
    }) => {
      if (data.user === otherUser && data.chatId === chatId) {
        setIsOtherUserTyping(data.isTyping);

        if (clearTimerRef.current) clearTimeout(clearTimerRef.current);

        // Safety auto-clear after 3 seconds
        if (data.isTyping) {
          clearTimerRef.current = setTimeout(() => {
            setIsOtherUserTyping(false);
          }, 3000);
        }
      }
    });

    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      setIsOtherUserTyping(false);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [otherUser, chatId, enabled]);

  return isOtherUserTyping;
}
