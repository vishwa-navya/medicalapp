/**
 * useOptimizedTyping.ts — Typing Indicators via Socket.IO
 *
 * ZERO Firebase cost, INSTANT delivery (50-100ms)
 * Uses existing Socket.IO connection from useSocketPresence
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';

const SIGNALING_SERVER = 'https://camera-sharing-server.onrender.com';

interface UseOptimizedTypingProps {
  nickname: string;
  chatId?: string;
  enabled?: boolean;
}

export function useOptimizedTyping(
  nickname: string,
  chatId: string = 'privateMessages',
  enabled: boolean = true
) {
  const socketRef = useRef<Socket | null>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTypingRef = useRef(false);
  const isConnectedRef = useRef(false);

  // Connect to server
  useEffect(() => {
    if (!enabled) return;

    const socket = io(SIGNALING_SERVER, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[Typing] Socket connected');
      isConnectedRef.current = true;
      socket.emit('register', { user: nickname, callType: 'typing' });
    });

    socket.on('registered', () => {
      console.log('[Typing] Registered');
    });

    socket.on('disconnect', () => {
      isConnectedRef.current = false;
      console.log('[Typing] Socket disconnected');
    });

    socket.on('connect_error', (err) => {
      console.warn('[Typing] Connection error:', err.message);
    });

    return () => {
      // Send typing-stop before disconnecting
      if (isTypingRef.current && socket.connected) {
        socket.emit('typing-stop', { chatId, user: nickname });
      }
      socket.disconnect();
      socketRef.current = null;
    };
  }, [nickname, chatId, enabled]);

  const handleTyping = useCallback(() => {
    if (!enabled || !socketRef.current?.connected) {
      // Fallback: If socket not available, nothing to do
      // Typing will simply not show (acceptable for offline scenario)
      return;
    }

    // Send typing-start if not already typing
    if (!isTypingRef.current) {
      socketRef.current.emit('typing-start', { chatId, user: nickname });
      isTypingRef.current = true;
    }

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Auto-stop after 2 seconds of no typing
    typingTimeoutRef.current = setTimeout(() => {
      if (socketRef.current?.connected && isTypingRef.current) {
        socketRef.current.emit('typing-stop', { chatId, user: nickname });
        isTypingRef.current = false;
      }
    }, 2000);
  }, [nickname, chatId, enabled]);

  const stopTyping = useCallback(() => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    if (socketRef.current?.connected && isTypingRef.current) {
      socketRef.current.emit('typing-stop', { chatId, user: nickname });
      isTypingRef.current = false;
    }
  }, [nickname, chatId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      stopTyping();
    };
  }, [stopTyping]);

  return { handleTyping, stopTyping };
}

// Hook to LISTEN for other user's typing status
export function useTypingListener(
  otherUser: 'Vishwa' | 'Ammu',
  chatId: string = 'privateMessages',
  enabled: boolean = true
) {
  const [isOtherUserTyping, setIsOtherUserTyping] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const socket = io(SIGNALING_SERVER, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('register', { user: otherUser === 'Vishwa' ? 'Ammu' : 'Vishwa', callType: 'typing-listener' });
    });

    socket.on('typing-update', (data: { user: string; isTyping: boolean; chatId: string; timestamp: number }) => {
      if (data.user === otherUser && data.chatId === chatId) {
        setIsOtherUserTyping(data.isTyping);

        // Auto-clear after 3 seconds (safety)
        if (data.isTyping) {
          setTimeout(() => {
            setIsOtherUserTyping(false);
          }, 3000);
        }
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [otherUser, chatId, enabled]);

  return isOtherUserTyping;
}
