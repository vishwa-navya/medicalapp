/**
 * useOptimizedTyping.ts — Fixed v2
 *
 * Problem: TWO separate Socket.IO connections were created
 *   - One for sending typing events
 *   - One for listening to typing events
 *   Each connection has its own handshake delay = slow
 *
 * Fix: ONE shared singleton socket for both send + listen
 * Result: Instant typing indicators, zero connection overhead
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';

const SIGNALING_SERVER = 'https://camera-sharing-server.onrender.com';

// ── Singleton socket shared across the entire app ─────────────────────────────
// Created once, reused everywhere — no duplicate connections
let sharedSocket: Socket | null = null;
let sharedSocketUsers = 0;

function getSharedSocket(): Socket {
  if (!sharedSocket || !sharedSocket.connected) {
    sharedSocket = io(SIGNALING_SERVER, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
    });
  }
  sharedSocketUsers++;
  return sharedSocket;
}

function releaseSharedSocket() {
  sharedSocketUsers--;

  // Only disconnect if nobody else is using it
  if (sharedSocketUsers <= 0 && sharedSocket) {
    sharedSocket.disconnect();
    sharedSocket = null;
    sharedSocketUsers = 0;
  }
}

// ── Main typing hook (send typing events) ────────────────────────────────────
export function useOptimizedTyping(
  nickname: string,
  chatId: string = 'privateMessages',
  enabled: boolean = true
) {
  const socketRef = useRef<Socket | null>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTypingRef = useRef(false);
  const registeredRef = useRef(false);

  // Connect once using shared socket
  useEffect(() => {
    if (!enabled) return;

    const socket = getSharedSocket();
    socketRef.current = socket;

    const onConnect = () => {
      if (!registeredRef.current) {
        socket.emit('register', { user: nickname });
        registeredRef.current = true;
      }
    };

    if (socket.connected) {
      onConnect();
    }

    socket.on('connect', onConnect);

    return () => {
      socket.off('connect', onConnect);

      // Stop typing before leaving
      if (isTypingRef.current && socket.connected) {
        socket.emit('typing-stop', { chatId, user: nickname });
        isTypingRef.current = false;
      }

      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      registeredRef.current = false;
      releaseSharedSocket();
    };
  }, [nickname, chatId, enabled]);

  const handleTyping = useCallback(() => {
    if (!enabled) return;

    const socket = socketRef.current;
    if (!socket?.connected) return;

    // Only send typing-start once per typing session
    if (!isTypingRef.current) {
      socket.emit('typing-start', { chatId, user: nickname });
      isTypingRef.current = true;
    }

    // Reset the auto-stop timer on every keystroke
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

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

  return {
    handleTyping,
    stopTyping,
  };
}

// ── Typing listener hook (receive other user's typing status) ─────────────────
export function useTypingListener(
  currentUser: 'Vishwa' | 'Ammu',
  chatId: string = 'privateMessages',
  enabled: boolean = true
) {
  const [isOtherUserTyping, setIsOtherUserTyping] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const clearTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!enabled) return;

    // Reuse shared socket — same connection as the sender
    const socket = getSharedSocket();
    socketRef.current = socket;

    const onConnect = () => {
      // Register as current user so server knows who this socket belongs to
      socket.emit('register', { user: currentUser });
    };

    if (socket.connected) {
      onConnect();
    }

    socket.on('connect', onConnect);

    // Listen for typing updates from server
    const onTypingUpdate = (data: {
      user: string;
      isTyping: boolean;
      chatId: string;
      timestamp: number;
    }) => {
      // Only show typing for the OTHER user, not ourselves
      if (data.user !== currentUser && data.chatId === chatId) {
        setIsOtherUserTyping(data.isTyping);

        // Safety: auto-clear after 3 seconds in case stop event is missed
        if (clearTimerRef.current) {
          clearTimeout(clearTimerRef.current);
        }

        if (data.isTyping) {
          clearTimerRef.current = setTimeout(() => {
            setIsOtherUserTyping(false);
          }, 3000);
        }
      }
    };

    socket.on('typing-update', onTypingUpdate);

    return () => {
      socket.off('connect', onConnect);
      socket.off('typing-update', onTypingUpdate);

      if (clearTimerRef.current) {
        clearTimeout(clearTimerRef.current);
      }

      setIsOtherUserTyping(false);

      releaseSharedSocket();
    };
  }, [currentUser, chatId, enabled]);

  return isOtherUserTyping;
}
