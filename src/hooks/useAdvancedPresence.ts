import { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../firebase';
import { doc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { lastSeenDb } from '../firebase-lastseen';

interface PresenceData {
  isOnline: boolean;
  lastSeen: any;
  lastActivity: any;
  deviceInfo?: {
    userAgent: string;
    isMobile: boolean;
    platform: string;
  };
  clientTimestamp?: string;
}

interface UseAdvancedPresenceProps {
  userId: string;
  otherUserId: string;
}

// 🔥 Rules for reliable notification:
// We consider other user ONLINE only if:
// - isOnline = true,
// - AND lastActivity < 8 seconds old (reduced for faster offline detection).
// In ALL other cases → treat as OFFLINE.
const ONLINE_WINDOW_MS = 8 * 1000;

export function useAdvancedPresence({ userId, otherUserId }: UseAdvancedPresenceProps) {
  const [isOtherUserOnline, setIsOtherUserOnline] = useState(false);
  const [otherUserLastSeen, setOtherUserLastSeen] = useState<string>('');
  const [connectionStatus, setConnectionStatus] = useState<'online' | 'offline' | 'connecting'>('connecting');

  // Self-presence trackers
  const heartbeatInterval = useRef<NodeJS.Timeout | null>(null);
  const lastPresenceUpdate = useRef(0);
  const isCurrentlyOnline = useRef(false);
  const isPageVisible = useRef(!document.hidden);
  const hasBeenOnline = useRef(false);

  // Cache for other user presence to avoid flickering states
  const lastKnownOtherOnline = useRef(false);
  const lastKnownOtherLastSeen = useRef('');

  // Device info
  const getDeviceInfo = useCallback(() => {
    const userAgent = navigator.userAgent;
    const isMobile =
      /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);

    return {
      userAgent,
      isMobile,
      platform: navigator.platform || 'Unknown'
    };
  }, []);

  // ---------- SELF PRESENCE UPDATE ----------
  const updatePresence = useCallback(
    async (isOnline: boolean, force = false) => {
      const now = Date.now();

      // Reduce write operations to Firestore (write at most every 3 seconds)
      if (!force && now - lastPresenceUpdate.current < 3000 && isCurrentlyOnline.current === isOnline) {
        return;
      }

      lastPresenceUpdate.current = now;
      isCurrentlyOnline.current = isOnline;

      try {
        await setDoc(
          doc(lastSeenDb, 'presence', userId),
          {
            isOnline,
            lastSeen: serverTimestamp(),
            lastActivity: serverTimestamp(),
            deviceInfo: getDeviceInfo(),
            clientTimestamp: new Date().toISOString()
          },
          { merge: true }
        );

        setConnectionStatus(isOnline ? 'online' : 'offline');

        if (isOnline) hasBeenOnline.current = true;

        // Legacy system support
        await setDoc(
          doc(db, 'users', userId),
          {
            isActive: isOnline,
            lastUpdate: new Date(),
            presenceTimestamp: new Date().toISOString()
          },
          { merge: true }
        );
      } catch (err) {
        console.error('❌ Error updating presence:', err);
      }
    },
    [userId, getDeviceInfo]
  );

  const setOnline = useCallback(() => {
    if (isPageVisible.current) updatePresence(true);
  }, [updatePresence]);

  const setOffline = useCallback(() => {
    updatePresence(false, true);
  }, [updatePresence]);

  // ---------- HEARTBEAT (Every 5 sec to maintain online - faster detection) ----------
  const startHeartbeat = useCallback(() => {
    if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);

    heartbeatInterval.current = setInterval(() => {
      if (isPageVisible.current) updatePresence(true);
    }, 5000);
  }, [updatePresence]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatInterval.current) {
      clearInterval(heartbeatInterval.current);
      heartbeatInterval.current = null;
    }
  }, []);

  // ---------- VISIBILITY EVENTS ----------
  useEffect(() => {
    const handleVisibility = () => {
      const visible = !document.hidden;
      isPageVisible.current = visible;

      if (visible) {
        setOnline();
        startHeartbeat();
      } else {
        setOffline();
        stopHeartbeat();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [setOnline, setOffline, startHeartbeat, stopHeartbeat]);

  // ---------- FOCUS / BLUR ----------
  useEffect(() => {
    const handleFocus = () => {
      if (isPageVisible.current) {
        setOnline();
        startHeartbeat();
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [setOnline, startHeartbeat]);

  // ---------- UNLOAD (IMMEDIATE OFFLINE SIGNAL) ----------
  useEffect(() => {
    const handleUnload = () => {
      // Immediate synchronous Firestore update before page closes
      // Using setDoc with merge to update immediately
      if (hasBeenOnline.current) {
        // Use fetch with keepalive for reliable delivery
        const presenceData = {
          isOnline: false,
          lastSeen: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          deviceInfo: getDeviceInfo(),
          _pendingWriteId: Date.now() + Math.random()
        };

        // Primary: sendBeacon (most reliable for page close)
        if (navigator.sendBeacon) {
          const blob = new Blob([JSON.stringify(presenceData)], {
            type: 'application/json'
          });
          navigator.sendBeacon(`/api/presence/${userId}`, blob);
        }

        // Fallback: Direct Firestore write (async, may not complete)
        setDoc(
          doc(lastSeenDb, 'presence', userId),
          {
            isOnline: false,
            lastSeen: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            offlineAt: serverTimestamp()
          },
          { merge: true }
        ).catch(() => {});
      }
    };

    // Use both events for maximum reliability
    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
    window.addEventListener('unload', handleUnload);

    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('pagehide', handleUnload);
      window.removeEventListener('unload', handleUnload);
    };
  }, [userId, getDeviceInfo]);

  // ---------- NETWORK ----------
  useEffect(() => {
    const handleOnline = () => {
      if (isPageVisible.current) {
        setOnline();
        startHeartbeat();
      }
    };

    const handleOffline = () => {
      setConnectionStatus('offline');
      stopHeartbeat();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setOnline, startHeartbeat, stopHeartbeat]);

  // ---------- INIT SELF ----------
  useEffect(() => {
    if (isPageVisible.current) {
      setOnline();
      startHeartbeat();
    }

    return () => {
      stopHeartbeat();
      // Do NOT call setOffline() here — this cleanup runs on every React unmount
      // (including normal navigation between Chat2 and Chat3), which causes the
      // other user to briefly see "offline" then "online" during page transitions.
      // Actual offline is handled by: the beforeunload handler above (tab close)
      // and the 40-second ONLINE_WINDOW_MS timeout in the listener.
    };
  }, [setOnline, startHeartbeat, stopHeartbeat]);

  // ---------- OTHER USER PRESENCE LISTENER (VERY IMPORTANT BLOCK) ----------
  useEffect(() => {
    const unsub = onSnapshot(
      doc(lastSeenDb, 'presence', otherUserId),
      docSnap => {
        if (!docSnap.exists()) {
          // No document means definitely offline
          setIsOtherUserOnline(false);
          setOtherUserLastSeen('');
          lastKnownOtherOnline.current = false;
          lastKnownOtherLastSeen.current = '';
          return;
        }

        const data = docSnap.data() as PresenceData;

        let isOnline = false;
        let formattedLastSeen = '';

        try {
          const lastActivity = data.lastActivity?.toDate
            ? data.lastActivity.toDate()
            : data.lastActivity
            ? new Date(data.lastActivity)
            : null;

          const now = Date.now();

          // Strong online detection
          if (
            data.isOnline &&
            lastActivity &&
            now - lastActivity.getTime() <= ONLINE_WINDOW_MS
          ) {
            isOnline = true;
          } else {
            isOnline = false;
          }

          if (!isOnline && data.lastSeen) {
            formattedLastSeen = formatLastSeen(data.lastSeen);
          }
        } catch (_) {
          isOnline = false;
        }

        // Save to cache
        lastKnownOtherOnline.current = isOnline;
        lastKnownOtherLastSeen.current = formattedLastSeen;

        // Update hook state
        setIsOtherUserOnline(isOnline);
        setOtherUserLastSeen(formattedLastSeen);
      },
      err => {
        // On Firestore error → fallback to cached state
        setIsOtherUserOnline(lastKnownOtherOnline.current);
        setOtherUserLastSeen(lastKnownOtherLastSeen.current);
      }
    );

    return unsub;
  }, [otherUserId]);

  // ---------- ACTIVITY ----------
  useEffect(() => {
    let timeout: NodeJS.Timeout | null = null;

    const handleActivity = () => {
      if (timeout) clearTimeout(timeout);

      if (isPageVisible.current) setOnline();

      timeout = setTimeout(() => {
        if (isPageVisible.current) updatePresence(true);
      }, 5 * 60 * 1000);
    };

    ['mousedown', 'keydown', 'touchstart', 'scroll'].forEach(event => {
      document.addEventListener(event, handleActivity, { passive: true });
    });

    return () => {
      if (timeout) clearTimeout(timeout);
      ['mousedown', 'keydown', 'touchstart', 'scroll'].forEach(event => {
        document.removeEventListener(event, handleActivity);
      });
    };
  }, [setOnline, updatePresence]);

  return {
    isOtherUserOnline,
    otherUserLastSeen,
    connectionStatus,
    setOnline,
    setOffline,
    forceUpdate: () => updatePresence(true, true)
  };
}

// ---------- FORMAT LAST SEEN ----------
function formatLastSeen(ts: any): string {
  if (!ts) return '';

  let date: Date;
  try {
    date = ts.toDate ? ts.toDate() : new Date(ts);
  } catch {
    return '';
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (date >= today) {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  return (
    date.getDate() +
    ' ' +
    date.toLocaleDateString('en-US', { month: 'short' }) +
    ' ' +
    date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit'
    })
  );
}
