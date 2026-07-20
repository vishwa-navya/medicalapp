/**
 * useLastSeen.ts — Unified Presence Hook
 *
 * Primary: Socket.IO (sub-second detection)
 * Fallback: Firestore (8 second detection window)
 *
 * Socket.IO provides instant online/offline updates (500ms-1s).
 * Firestore is kept as backup for reliability.
 */

import { useState, useEffect, useRef } from 'react';
import { useSocketPresence } from './useSocketPresence';
import { useAdvancedPresence } from './useAdvancedPresence';

interface UseLastSeenProps {
  userId: string;
  otherUserId: string;
}

export function useLastSeen({ userId, otherUserId }: UseLastSeenProps) {
  // Primary: Socket.IO for real-time presence
  const socketPresence = useSocketPresence({
    userId,
    otherUserId,
    enabled: true,
  });

  // Fallback: Firestore for reliability
  const firestorePresence = useAdvancedPresence({
    userId,
    otherUserId,
  });

  // Use Socket.IO as primary, Firestore as fallback
  // Socket.IO is faster (500ms-1s), Firestore is slower but more reliable (8s)
  const [isOtherUserOnline, setIsOtherUserOnline] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'online' | 'offline' | 'connecting'>('connecting');

  // Socket.IO status takes priority when connected
  const socketConnected = socketPresence.connectionStatus === 'online';

  useEffect(() => {
    if (socketConnected) {
      // Use Socket.IO status (real-time, sub-second)
      setIsOtherUserOnline(socketPresence.isOtherUserOnline);
      setConnectionStatus('online');
    } else {
      // Fallback to Firestore (slower but reliable)
      setIsOtherUserOnline(firestorePresence.isOtherUserOnline);
      setConnectionStatus(firestorePresence.connectionStatus);
    }
  }, [
    socketConnected,
    socketPresence.isOtherUserOnline,
    firestorePresence.isOtherUserOnline,
    socketPresence.connectionStatus,
    firestorePresence.connectionStatus,
  ]);

  // Last seen: prefer Socket.IO timestamp, fallback to Firestore
  const otherUserLastSeen = socketPresence.otherUserLastSeen || firestorePresence.otherUserLastSeen;

  return {
    otherUserLastSeen,
    isOtherUserOnline,
    connectionStatus,
    setOnline: firestorePresence.setOnline,
    setOffline: firestorePresence.setOffline,
  };
}
