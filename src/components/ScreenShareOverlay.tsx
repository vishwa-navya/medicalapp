/**
 * ScreenShareOverlay.tsx
 * Floating draggable popup for screen share viewer
 * Same behavior as CameraShareOverlay — drag, fullscreen, minimize, close
 * Speaker ON by default (unlike voice call where earpiece is default)
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Maximize2, Minimize2, X, Monitor, Volume2, VolumeX, Loader2 } from "lucide-react";

interface ScreenShareOverlayProps {
  remoteStream:  MediaStream | null;
  localStream:   MediaStream | null; // sharer's own preview (PiP)
  status:        "idle" | "connecting" | "sharing" | "viewing" | "error";
  errorMsg:      string | null;
  nickname:      "Vishwa" | "Ammu";
  sharerName:    string | null;
  isSharing:     boolean;   // true = I am the one sharing
  isSpeakerOn:   boolean;
  onToggleSpeaker: () => void;
  onClose:       () => void;
}

// ── Video element ─────────────────────────────────────────────────────────────
function Vid({ stream, muted = false, style, label, contain = false }: {
  stream: MediaStream | null; muted?: boolean;
  style?: React.CSSProperties; label?: string; contain?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (stream) { el.srcObject = stream; el.play().catch(() => {}); }
    else el.srcObject = null;
  }, [stream]);
  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);
  return (
    <div style={{ position: "relative", ...style }}>
      <video ref={ref} autoPlay playsInline muted={muted}
        style={{ width: "100%", height: "100%", objectFit: contain ? "contain" : "cover", display: "block", background: "#000" }}
      />
      {label && (
        <span style={{
          position: "absolute", bottom: 4, left: 6, fontSize: 10,
          color: "rgba(255,255,255,0.9)", background: "rgba(0,0,0,0.55)",
          borderRadius: 4, padding: "1px 6px", pointerEvents: "none", fontWeight: 600,
        }}>{label}</span>
      )}
    </div>
  );
}

// ── Control button ────────────────────────────────────────────────────────────
function Btn({ children, onClick, title, danger = false, active = false }: {
  children: React.ReactNode; onClick: () => void;
  title?: string; danger?: boolean; active?: boolean;
}) {
  return (
    <button onClick={onClick} title={title} style={{
      width: 24, height: 24, borderRadius: "50%", border: "none", cursor: "pointer",
      background: danger ? "rgba(239,68,68,0.85)" : active ? "rgba(34,197,94,0.85)" : "rgba(255,255,255,0.22)",
      color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, transition: "transform .12s",
    }}
    onMouseEnter={e => { (e.currentTarget as any).style.transform = "scale(1.15)"; }}
    onMouseLeave={e => { (e.currentTarget as any).style.transform = "scale(1)"; }}
    >{children}</button>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function Toast({ msg, onDone }: { msg: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div style={{
      position: "fixed", top: 80, left: "50%", transform: "translateX(-50%)",
      zIndex: 9999, background: "linear-gradient(135deg,#3b82f6,#1d4ed8)",
      color: "#fff", padding: "8px 18px", borderRadius: 999, fontSize: 13,
      fontWeight: 600, boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
      display: "flex", alignItems: "center", gap: 8,
      animation: "toastIn .3s ease", whiteSpace: "nowrap", pointerEvents: "none",
    }}>
      <Monitor style={{ width: 14, height: 14 }} />
      {msg}
      <style>{`@keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(-10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`}</style>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ScreenShareOverlay({
  remoteStream, localStream, status, errorMsg,
  nickname, sharerName, isSharing,
  isSpeakerOn, onToggleSpeaker, onClose,
}: ScreenShareOverlayProps) {

  const [fullscreen, setFullscreen] = useState(false);
  const [minimized,  setMinimized]  = useState(false);
  const [toast,      setToast]      = useState<string | null>(null);

  const boxRef     = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStart  = useRef({ x: 0, y: 0 });
  const boxStart   = useRef({ x: 0, y: 0 });
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const displayName = sharerName ?? (isSharing ? nickname : (nickname === "Vishwa" ? "Ammu" : "Vishwa"));

  // Toast on stream arrive/leave
  const prevRemote = useRef<MediaStream | null>(null);
  useEffect(() => {
    if (remoteStream && !prevRemote.current) setToast(`${displayName} started screen sharing`);
    if (!remoteStream && prevRemote.current) setToast(`${displayName} stopped screen sharing`);
    prevRemote.current = remoteStream;
  }, [remoteStream, displayName]);

  useEffect(() => {
    if (isSharing) setToast("You started screen sharing");
  }, [isSharing]);

  // Default position — right side desktop, center-bottom mobile
  const getDefaultPos = useCallback(() => {
    const isMobile = window.innerWidth < 768;
    const W = isMobile ? 300 : 420;
    const H = Math.round(W * 9/16);
    return isMobile
      ? { x: Math.round((window.innerWidth - W) / 2), y: window.innerHeight - H - 140 }
      : { x: window.innerWidth - W - 20, y: Math.round((window.innerHeight - H) / 2) };
  }, []);

  useEffect(() => { setPos(p => p ?? getDefaultPos()); }, [getDefaultPos]);
  useEffect(() => { if (!fullscreen) setPos(getDefaultPos()); }, [fullscreen, getDefaultPos]);

  const clamp = useCallback((x: number, y: number) => {
    const W = boxRef.current?.offsetWidth  ?? 420;
    const H = boxRef.current?.offsetHeight ?? 236;
    return { x: Math.max(0, Math.min(x, window.innerWidth - W)), y: Math.max(0, Math.min(y, window.innerHeight - H)) };
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    isDragging.current = true;
    dragStart.current  = { x: e.clientX, y: e.clientY };
    boxStart.current   = pos ?? getDefaultPos();
  }, [pos, getDefaultPos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      setPos(clamp(boxStart.current.x + e.clientX - dragStart.current.x, boxStart.current.y + e.clientY - dragStart.current.y));
    };
    const onUp = () => { isDragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [clamp]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const t = e.touches[0];
    isDragging.current = true;
    dragStart.current  = { x: t.clientX, y: t.clientY };
    boxStart.current   = pos ?? getDefaultPos();
  }, [pos, getDefaultPos]);

  useEffect(() => {
    const onMove = (e: TouchEvent) => {
      if (!isDragging.current) return;
      e.preventDefault();
      const t = e.touches[0];
      setPos(clamp(boxStart.current.x + t.clientX - dragStart.current.x, boxStart.current.y + t.clientY - dragStart.current.y));
    };
    const onEnd = () => { isDragging.current = false; };
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend",  onEnd);
    return () => { window.removeEventListener("touchmove", onMove); window.removeEventListener("touchend", onEnd); };
  }, [clamp]);

  const handleClose = () => { setToast("Screen sharing stopped"); setTimeout(onClose, 300); };

  // What stream to show as main view
  // Viewer: show remoteStream (sharer's screen)
  // Sharer: show localStream (their own screen preview)
  const mainStream = isSharing ? localStream : remoteStream;
  const mainLabel  = isSharing ? "Your screen (sharing)" : `${displayName}'s screen`;

  const dotColor = status === "viewing" || status === "sharing" ? "#22c55e" :
                   status === "connecting"                      ? "#facc15" :
                   status === "error"                           ? "#ef4444" : "#9ca3af";

  // ── Control bar ─────────────────────────────────────────────────────────────
  const ControlBar = () => (
    <div style={{
      position: "absolute", top: 0, left: 0, right: 0, zIndex: 10,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "7px 8px",
      background: "linear-gradient(to bottom,rgba(0,0,0,0.7),transparent)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, display: "inline-block" }} />
        <Monitor size={11} color="rgba(255,255,255,0.8)" />
        <span style={{ color: "rgba(255,255,255,0.8)", fontSize: 11, fontWeight: 600 }}>
          {status === "sharing" ? "Sharing" : status === "viewing" ? "Live" : status === "connecting" ? "Connecting…" : "Screen Share"}
        </span>
      </div>
      <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 9, flex: 1, textAlign: "center" }}>⠿ drag</span>
      <div style={{ display: "flex", gap: 4 }}>
        {/* Speaker toggle — only for viewer */}
        {!isSharing && (
          <Btn title={isSpeakerOn ? "Mute" : "Unmute"} onClick={onToggleSpeaker} active={isSpeakerOn}>
            {isSpeakerOn ? <Volume2 size={11} /> : <VolumeX size={11} />}
          </Btn>
        )}
        <Btn title="Fullscreen" onClick={() => { setFullscreen(true); setMinimized(false); }}>
          <Maximize2 size={11} />
        </Btn>
        <Btn title="Minimize" onClick={() => { setMinimized(true); setFullscreen(false); }}>
          <Minimize2 size={11} />
        </Btn>
        <Btn title="Stop screen share" onClick={handleClose} danger>
          <X size={11} />
        </Btn>
      </div>
    </div>
  );

  if (!isSharing && !remoteStream && status === "idle") return null;

  // ── Fullscreen ───────────────────────────────────────────────────────────────
  if (fullscreen) {
    return (
      <>
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
        <div style={{ position: "fixed", inset: 0, zIndex: 500, background: "#000", display: "flex", flexDirection: "column" }}>
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, zIndex: 10,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 16px",
            background: "linear-gradient(to bottom,rgba(0,0,0,0.7),transparent)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Monitor size={16} color="#22c55e" />
              <span style={{ color: "#fff", fontWeight: 700, fontSize: 14 }}>{mainLabel}</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {!isSharing && (
                <Btn title={isSpeakerOn ? "Mute" : "Unmute"} onClick={onToggleSpeaker} active={isSpeakerOn}>
                  {isSpeakerOn ? <Volume2 size={13} /> : <VolumeX size={13} />}
                </Btn>
              )}
              <Btn title="Exit fullscreen" onClick={() => setFullscreen(false)}>
                <Minimize2 size={13} />
              </Btn>
              <Btn title="Stop sharing" onClick={handleClose} danger>
                <X size={13} />
              </Btn>
            </div>
          </div>
          <div style={{ flex: 1, position: "relative" }}>
            {mainStream
              ? <Vid stream={mainStream} muted={isSharing} contain
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                  label={mainLabel}
                />
              : (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
                  {status === "connecting"
                    ? <><Loader2 size={36} color="#3b82f6" style={{ animation: "spin 1s linear infinite" }} /><span style={{ color: "rgba(255,255,255,0.5)", fontSize: 14 }}>Connecting…</span></>
                    : <><Monitor size={40} color="rgba(255,255,255,0.2)" /><span style={{ color: "rgba(255,255,255,0.3)", fontSize: 14 }}>Waiting for screen share…</span></>
                  }
                  <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
                </div>
              )
            }
          </div>
        </div>
      </>
    );
  }

  // ── Minimized pill ───────────────────────────────────────────────────────────
  if (minimized) {
    return (
      <>
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
        <div onClick={() => setMinimized(false)} style={{
          position: "fixed", bottom: 110, right: 20, zIndex: 500,
          background: "linear-gradient(135deg,#3b82f6,#1d4ed8)",
          borderRadius: 999, padding: "8px 14px",
          display: "flex", alignItems: "center", gap: 8,
          cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        }}>
          <Monitor size={14} color="#fff" />
          <span style={{ color: "#fff", fontSize: 12, fontWeight: 600 }}>Screen Share</span>
          {(mainStream) && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", display: "inline-block" }} />}
        </div>
      </>
    );
  }

  // ── Floating window ──────────────────────────────────────────────────────────
  const W = window.innerWidth < 768 ? 300 : 420;
  const defaultPos = getDefaultPos();

  return (
    <>
      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
      <div
        ref={boxRef}
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        style={{
          position: "fixed",
          left: pos?.x ?? defaultPos.x,
          top:  pos?.y ?? defaultPos.y,
          width: W,
          zIndex: 500,
          cursor: "grab",
          userSelect: "none",
          touchAction: "none",
        }}
      >
        <div style={{
          borderRadius: 12, overflow: "hidden",
          background: "#0f172a",
          boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
          border: "1px solid rgba(255,255,255,0.12)",
          aspectRatio: "16/9",
          position: "relative",
        }}>
          <ControlBar />
          {mainStream
            ? <Vid stream={mainStream} muted={isSharing} contain
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                label={mainLabel}
              />
            : (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
                {status === "connecting"
                  ? <><Loader2 size={28} color="#3b82f6" style={{ animation: "spin 1s linear infinite" }} /><span style={{ color: "rgba(255,255,255,0.4)", fontSize: 12 }}>Connecting…</span><style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style></>
                  : <><Monitor size={28} color="rgba(255,255,255,0.15)" /><span style={{ color: "rgba(255,255,255,0.25)", fontSize: 12 }}>Waiting for screen share…</span></>
                }
              </div>
            )
          }
          {/* Speaker indicator for viewer */}
          {!isSharing && mainStream && (
            <div style={{
              position: "absolute", bottom: 8, right: 8, zIndex: 5,
              background: "rgba(0,0,0,0.6)", borderRadius: 99,
              padding: "3px 8px", display: "flex", alignItems: "center", gap: 4,
            }}>
              {isSpeakerOn
                ? <Volume2 size={10} color="#22c55e" />
                : <VolumeX size={10} color="#fbbf24" />
              }
              <span style={{ color: isSpeakerOn ? "#22c55e" : "#fbbf24", fontSize: 9, fontWeight: 600 }}>
                {isSpeakerOn ? "Sound on" : "Muted"}
              </span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
