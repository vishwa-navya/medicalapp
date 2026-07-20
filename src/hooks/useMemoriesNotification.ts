/**
 * useMemoriesNotification — Real-time presence + unread message tracking
 * for the Smart Notification component in the Memories module.
 *
 * - Tracks the OTHER user's online/offline status via Firestore lastSeenDb
 *   (read-only, no heartbeat — does not conflict with Chat2's presence).
 * - Listens to the latest `privateMessages` document. When a new message
 *   arrives from the other user that is NOT marked as seen by the current
 *   user, it becomes the "latest unread" and the unread count increments.
 * - The hook is designed to be mounted ONCE at the Memories module root
 *   so navigation between internal Memories pages does not reset state.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  doc,
} from "firebase/firestore";
import { db } from "../firebase";
import { lastSeenDb } from "../firebase-lastseen";

// Match the heartbeat interval used by useAdvancedPresence (every 3s heartbeat,
// so 10s window gives 3 missed beats before we declare offline).
const ONLINE_WINDOW_MS = 10_000;
// How often we re-evaluate stale lastActivity without waiting for a new snapshot.
const RECHECK_INTERVAL_MS = 3_000;

export interface UnreadMessageInfo {
  id: string;
  text: string;
  by: string;
  ts: any;
  type: string;
  imageUrl?: string;
  videoUrl?: string;
  fileUrl?: string;
  fileName?: string;
  mimeType?: string;
}

export interface MemoriesNotificationState {
  isOtherOnline: boolean;
  unreadCount: number;
  latestUnread: UnreadMessageInfo | null;
  otherUserDp: string;
  otherUserName: string;
  clearUnread: () => void;
}

// Profile picture URLs (same as used elsewhere in the app)
const DP_MAP: Record<string, string> = {
  Vishwa: "https://i.postimg.cc/wTrF15j3/Whats-App-Image-2025-08-14-at-22-29-55-ed72594e.jpg",
  Ammu: "https://i.postimg.cc/SRGbptyj/Whats-App-Image-2025-08-15-at-22-32-21-9e7fdfe7.jpg",
};

export function useMemoriesNotification(
  nickname: "Vishwa" | "Ammu"
): MemoriesNotificationState {
  const otherUser = nickname === "Vishwa" ? "Ammu" : "Vishwa";
  const otherUserDp = DP_MAP[otherUser] ?? "";

  const [isOtherOnline, setIsOtherOnline] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [latestUnread, setLatestUnread] = useState<UnreadMessageInfo | null>(null);

  // Track which message IDs we've already counted to avoid double-counting
  const countedRef = useRef<Set<string>>(new Set());
  // Track the latest message doc snapshot for re-evaluation
  const latestMsgRef = useRef<any>(null);
  // Cache raw Firestore presence data for periodic re-evaluation
  const presenceDataRef = useRef<any>(null);

  // ── Presence: read-only listener on lastSeenDb + periodic re-evaluation ──
  useEffect(() => {
    const evaluatePresence = () => {
      const data = presenceDataRef.current;
      if (!data) {
        setIsOtherOnline(false);
        return;
      }
      try {
        const lastActivity = data.lastActivity?.toDate
          ? data.lastActivity.toDate()
          : null;
        const online = !!(
          data.isOnline &&
          lastActivity &&
          Date.now() - lastActivity.getTime() <= ONLINE_WINDOW_MS
        );
        setIsOtherOnline(online);
      } catch {
        setIsOtherOnline(false);
      }
    };

    const unsub = onSnapshot(
      doc(lastSeenDb, "presence", otherUser),
      (snap) => {
        if (!snap.exists()) {
          presenceDataRef.current = null;
          setIsOtherOnline(false);
          return;
        }
        presenceDataRef.current = snap.data();
        evaluatePresence();
      },
      () => {
        /* presence is non-critical */
      }
    );

    // Periodically re-evaluate so a stale lastActivity (user closed app without
    // writing isOnline:false) flips the dot off without needing a new snapshot.
    const interval = setInterval(evaluatePresence, RECHECK_INTERVAL_MS);

    return () => {
      unsub();
      clearInterval(interval);
    };
  }, [otherUser]);

  // ── Unread message tracking via privateMessages ─────────────────────────
  // We listen to the latest 50 messages (ordered desc) and find ones from
  // the other user that don't have the current user in seenBy[].
  useEffect(() => {
    const q = query(
      collection(db, "privateMessages"),
      orderBy("ts", "desc"),
      limit(50)
    );

    const unsub = onSnapshot(q, (snap) => {
      if (snap.empty) return;

      const allDocs = snap.docs;
      // Find unread messages from the other user
      const unreads: UnreadMessageInfo[] = [];
      let newestUnread: UnreadMessageInfo | null = null;

      for (const d of allDocs) {
        const data = d.data() as any;
        // Skip system messages and own messages
        if (data.by !== otherUser) continue;
        if (data.type === "system") continue;
        // Skip messages deleted for this user
        if (data.deletedFor && Array.isArray(data.deletedFor) && data.deletedFor.includes(nickname)) continue;

        // Check if seen by current user
        const seenBy: string[] = Array.isArray(data.seenBy) ? data.seenBy : [];
        if (seenBy.includes(nickname)) continue;

        // This is an unread message from the other user
        const msg: UnreadMessageInfo = {
          id: d.id,
          text: data.text || "",
          by: data.by,
          ts: data.ts,
          type: data.type || "text",
          imageUrl: data.imageUrl,
          videoUrl: data.videoUrl,
          fileUrl: data.fileUrl,
          fileName: data.fileName,
          mimeType: data.mimeType,
        };

        unreads.push(msg);
      }

      // Sort unreads by timestamp ascending to find the newest
      unreads.sort((a, b) => {
        const aTime = a.ts?.toDate ? a.ts.toDate().getTime() : (a.ts?.seconds ? a.ts.seconds * 1000 : 0);
        const bTime = b.ts?.toDate ? b.ts.toDate().getTime() : (b.ts?.seconds ? b.ts.seconds * 1000 : 0);
        return aTime - bTime;
      });

      if (unreads.length > 0) {
        newestUnread = unreads[unreads.length - 1];
        setUnreadCount(unreads.length);
        setLatestUnread(newestUnread);
      } else {
        setUnreadCount(0);
        setLatestUnread(null);
      }
    });

    return unsub;
  }, [otherUser, nickname]);

  // ── Clear unread state (called when user exits Memories module) ──────────
  const clearUnread = useCallback(() => {
    setUnreadCount(0);
    setLatestUnread(null);
    countedRef.current.clear();
  }, []);

  return {
    isOtherOnline,
    unreadCount,
    latestUnread,
    otherUserDp,
    otherUserName: otherUser,
    clearUnread,
  };
}
