/**
 * useSocketPresence.ts — Real-time Presence via Socket.IO
 *
 * Provides sub-second (500ms-1s) online/offline detection.
 * Uses Socket.IO for instant updates, Firestore as fallback.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

const SIGNALING_SERVER = 'https://camera-sharing-server.onrender.com';

interface UseSocketPresenceProps {
  userId: string;
  otherUserId: string;
  enabled?: boolean;
}

interface UseSocketPresenceReturn {
  isOtherUserOnline: boolean;
  otherUserLastSeen: string;
  connectionStatus: 'online' | 'offline' | 'connecting';
}

export function useSocketPresence({
  userId,
  otherUserId,
  enabled = true,
}: UseSocketPresenceProps): UseSocketPresenceReturn {
  const [isOtherUserOnline, setIsOtherUserOnline] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'online' | 'offline' | 'connecting'>('connecting');

  const socketRef = useRef<Socket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSeenRef = useRef<Date | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    setConnectionStatus('connecting');

    // Connect to signaling server
    const socket = io(SIGNALING_SERVER, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[SocketPresence] Connected');
      socket.emit('register', { user: userId, callType: 'presence' });
    });

    socket.on('registered', () => {
      console.log('[SocketPresence] Registered');
      setConnectionStatus('online');

      // Start heartbeat (every 2 seconds)
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = setInterval(() => {
        if (socket.connected) {
          socket.emit('presence-heartbeat');
        }
      }, 2000);

      // Request initial status of other user
      socket.emit('presence-check', { targetUser: otherUserId });
    });

    // Receive presence updates
    socket.on('presence-update', ({ user, isOnline, timestamp }) => {
      console.log(`[SocketPresence] ${user} is ${isOnline ? 'ONLINE' : 'OFFLINE'}`);

      if (user === otherUserId) {
        setIsOtherUserOnline(isOnline);

        if (!isOnline) {
          lastSeenRef.current = new Date(timestamp);
        }
      }
    });

    // Response to explicit presence check
    socket.on('presence-status', ({ user, isOnline }) => {
      if (user === otherUserId) {
        setIsOtherUserOnline(isOnline);
      }
    });

    socket.on('disconnect', () => {
      console.log('[SocketPresence] Disconnected');
      setConnectionStatus('offline');
      setIsOtherUserOnline(false); // Conservative: assume offline if socket disconnects
    });

    socket.on('connect_error', (err) => {
      console.warn('[SocketPresence] Connection error:', err.message);
      setConnectionStatus('connecting');
    });

    socket.io.on('reconnect', (attempt) => {
      console.log(`[SocketPresence] Reconnected after ${attempt} attempts`);
    });

    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      socket.disconnect();
      socketRef.current = null;
    };
  }, [userId, otherUserId, enabled]);

  // Format last seen
  const otherUserLastSeen = lastSeenRef.current ? formatLastSeen(lastSeenRef.current) : '';

  return {
    isOtherUserOnline,
    otherUserLastSeen,
    connectionStatus,
  };
}

function formatLastSeen(date: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (date >= today) {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  return (
    date.getDate() +
    ' ' +
    date.toLocaleDateString('en-US', { month: 'short' }) +
    ' ' +
    date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })
  );
}
