/**
 * SmartNotification — iPhone Dynamic Island–style notification for the
 * Memories module header.
 *
 * States:
 * 1. IDLE: Shows only the other user's DP with a green online dot.
 * 2. EXPANDED: DP slides left, a rounded pill container expands showing
 *    sender DP, message preview (truncated), and unread count badge.
 *
 * The component is fully controlled by the parent via props, so state
 * persists across internal Memories page navigations without resetting.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useIsMobile } from "../hooks/use-mobile";
import type { UnreadMessageInfo } from "../hooks/useMemoriesNotification";

interface SmartNotificationProps {
  isOtherOnline: boolean;
  unreadCount: number;
  latestUnread: UnreadMessageInfo | null;
  otherUserDp: string;
  otherUserName: string;
  theme?: "light" | "dark";
}

export default function SmartNotification({
  isOtherOnline,
  unreadCount,
  latestUnread,
  otherUserDp,
  otherUserName,
  theme = "light",
}: SmartNotificationProps) {
  const isMobile = useIsMobile();
  const hasUnread = unreadCount > 0 && latestUnread !== null;

  // Determine message preview text
  const previewText = (() => {
    if (!latestUnread) return "";
    if (latestUnread.type === "image") return "📷 Photo";
    if (latestUnread.type === "video") return "🎥 Video";
    if (latestUnread.type === "audio" || latestUnread.mimeType?.startsWith("audio/")) return "🎤 Voice message";
    if (latestUnread.type === "file") return "📎 File";
    return latestUnread.text || "";
  })();

  // Dynamic truncation based on available width
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [truncatedText, setTruncatedText] = useState(previewText);

  useEffect(() => {
    if (!hasUnread || !previewText) {
      setTruncatedText(previewText);
      return;
    }

    // Calculate max chars based on device and container width
    const calculateTruncation = () => {
      if (!containerRef.current || !textRef.current) {
        // Fallback: mobile ~25 chars, desktop ~40 chars
        setTruncatedText(truncateText(previewText, isMobile ? 25 : 40));
        return;
      }

      const containerWidth = containerRef.current.offsetWidth;
      // Reserve space for DP (28px), badge (~28px), padding/gaps (~24px)
      const reservedWidth = 80;
      const availableWidth = containerWidth - reservedWidth;
      // Approximate: average char width ~7px at 13px font size
      const avgCharWidth = 7;
      const maxChars = Math.max(10, Math.floor(availableWidth / avgCharWidth));
      setTruncatedText(truncateText(previewText, maxChars));
    };

    // Use requestAnimationFrame to avoid layout thrashing
    const raf = requestAnimationFrame(calculateTruncation);
    // Recalculate on resize
    window.addEventListener("resize", calculateTruncation);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", calculateTruncation);
    };
  }, [previewText, hasUnread, isMobile]);

  const isDark = theme === "dark";

  return (
    <div
      ref={containerRef}
      className="flex items-center justify-end"
      style={{ minHeight: 44 }}
    >
      {/* Dynamic Island pill — 3D glass effect */}
      <motion.div
        layout
        className="flex items-center rounded-full overflow-hidden"
        style={{
          /* 3D layered shadow for depth */
          background: isDark
            ? "linear-gradient(135deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.08) 100%)"
            : "linear-gradient(145deg, #ffffff 0%, #f0f0f0 100%)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          /* top-left highlight + bottom-right depth shadow = 3D look */
          boxShadow: isDark
            ? "0 1px 0 0 rgba(255,255,255,0.3) inset, 0 -1px 0 0 rgba(0,0,0,0.2) inset, 0 6px 20px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.2)"
            : "0 1px 0 0 rgba(255,255,255,0.9) inset, 0 -1px 0 0 rgba(0,0,0,0.08) inset, 0 4px 16px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.1)",
          border: isDark
            ? "1px solid rgba(255,255,255,0.25)"
            : "1px solid rgba(200,200,200,0.6)",
          padding: hasUnread ? "4px 10px 4px 4px" : "4px",
          gap: hasUnread ? 8 : 0,
        }}
        transition={{
          type: "spring",
          stiffness: 380,
          damping: 30,
          mass: 0.7,
        }}
      >
        {/* DP — single, always visible */}
        <motion.div layout className="relative flex-shrink-0">
          <img
            src={otherUserDp}
            alt={otherUserName}
            className="rounded-full object-cover"
            style={{
              width: 36,
              height: 36,
              border: isDark
                ? "2px solid rgba(255,255,255,0.5)"
                : "2px solid rgba(255,255,255,0.9)",
              boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
            }}
          />
          {/* Green online dot */}
          <AnimatePresence>
            {isOtherOnline && (
              <motion.div
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
                style={{
                  position: "absolute",
                  bottom: 1,
                  right: 1,
                  width: 11,
                  height: 11,
                  borderRadius: "50%",
                  background: "#22c55e",
                  border: "2px solid white",
                  boxShadow: "0 0 5px rgba(34,197,94,0.7)",
                }}
              />
            )}
          </AnimatePresence>
        </motion.div>

        {/* Expandable content — no second DP */}
        <AnimatePresence>
          {hasUnread && (
            <motion.div
              key="notif-body"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: "auto", opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{
                type: "spring",
                stiffness: 380,
                damping: 30,
                opacity: { duration: 0.15 },
              }}
              className="flex items-center gap-2 overflow-hidden"
            >
              {/* Message preview */}
              <span
                ref={textRef}
                style={{
                  maxWidth: isMobile ? 120 : 200,
                  fontSize: 12,
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: isDark ? "rgba(255,255,255,0.92)" : "#1f2937",
                }}
              >
                {truncatedText}
              </span>

              {/* Unread count badge */}
              <div
                style={{
                  minWidth: 20,
                  height: 20,
                  borderRadius: 10,
                  background: "linear-gradient(135deg, #ef4444, #dc2626)",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 11,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 5px",
                  flexShrink: 0,
                  boxShadow: "0 2px 6px rgba(239,68,68,0.5), 0 1px 0 rgba(255,255,255,0.2) inset",
                }}
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + "…";
}
