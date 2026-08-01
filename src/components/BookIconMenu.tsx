/**
 * BookIconMenu.tsx — v4 (3 options: Call, Camera, Screen Share)
 * Vertical popup, never overflows off-screen
 */

import React, { useRef, useEffect, useState, useCallback } from "react";
import { BookOpen, Phone, Camera, Monitor } from "lucide-react";

interface BookIconMenuProps {
  isCameraSharing: boolean;
  isInCall:        boolean;
  isScreenSharing: boolean;
  onStartCamera:   () => void;
  onStartCall:     () => void;
  onStartScreenShare: () => void;
}

export default function BookIconMenu({
  isCameraSharing, isInCall, isScreenSharing,
  onStartCamera, onStartCall, onStartScreenShare,
}: BookIconMenuProps) {
  const [open, setOpen]           = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef      = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown",  close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown",  close);
      document.removeEventListener("touchstart", close);
    };
  }, [open]);

  const calcPosition = useCallback(() => {
    if (!containerRef.current || !menuRef.current) return;
    const btnRect = containerRef.current.getBoundingClientRect();
    const menuW   = menuRef.current.offsetWidth  || 80;
    const menuH   = menuRef.current.offsetHeight || 170;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 8;
    let top  = btnRect.bottom + gap;
    let left = btnRect.left + btnRect.width / 2 - menuW / 2;
    left = Math.max(8, Math.min(left, vw - menuW - 8));
    if (top + menuH > vh - 8) top = btnRect.top - menuH - gap;
    setMenuStyle({ position: "fixed", top, left, zIndex: 300 });
  }, []);

  useEffect(() => { if (open) requestAnimationFrame(calcPosition); }, [open, calcPosition]);

  const isActive = isCameraSharing || isInCall || isScreenSharing;

  return (
    <div ref={containerRef} style={{ position: "relative", flexShrink: 0, display: "inline-flex" }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Call, Camera, or Screen Share"
        style={{
          width: 32, height: 32, borderRadius: "50%", border: "none",
          background: isActive ? "#10b981" : "transparent",
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background .2s", position: "relative", padding: 0,
        }}
      >
        <BookOpen style={{ width: 20, height: 20, color: isActive ? "#fff" : "#16a34a" }} strokeWidth={2} />
        {isActive && (
          <span style={{ position: "absolute", top: 0, right: 0, width: 8, height: 8, borderRadius: "50%", background: "#ef4444", border: "2px solid #fff" }} />
        )}
      </button>

      {open && (
        <div ref={menuRef} style={{
          ...menuStyle, background: "#fff", borderRadius: 16, padding: "10px 8px",
          boxShadow: "0 4px 20px rgba(0,0,0,0.14)", border: "1px solid rgba(0,0,0,0.07)",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
          minWidth: 70, animation: "menuPop .15s ease",
        }}>
          <style>{`@keyframes menuPop{from{opacity:0;transform:scale(0.9)}to{opacity:1;transform:scale(1)}}`}</style>

          <MenuItem icon={<Phone size={17} color={isInCall ? "#fff" : "#10b981"} />} label="Call"
            bg={isInCall ? "#10b981" : "#f0fdf4"}
            onClick={() => { setOpen(false); onStartCall(); }} />

          <MenuItem icon={<Camera size={17} color={isCameraSharing ? "#fff" : "#3b82f6"} />} label="Camera"
            bg={isCameraSharing ? "#3b82f6" : "#eff6ff"}
            onClick={() => { setOpen(false); onStartCamera(); }} />

          <MenuItem icon={<Monitor size={17} color={isScreenSharing ? "#fff" : "#8b5cf6"} />} label="Screen"
            bg={isScreenSharing ? "#8b5cf6" : "#f5f3ff"}
            onClick={() => { setOpen(false); onStartScreenShare(); }} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, bg, onClick }: {
  icon: React.ReactNode; label: string; bg: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
      background: "transparent", border: "none", cursor: "pointer", padding: "2px 4px", width: "100%",
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: "50%", background: bg,
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "transform .12s", flexShrink: 0,
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = "scale(1.1)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = "scale(1)"; }}
      >{icon}</div>
      <span style={{ fontSize: 10, color: "#6b7280", fontWeight: 600, whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}
