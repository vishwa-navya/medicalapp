/**
 * useScreenShare.ts — FIXED v3
 *
 * ROOT CAUSE OF BUG:
 * Vishwa starts sharing → joins room → emits share-ready
 * Ammu opens app LATER → joins room → emits share-viewer-join
 * BUT: Vishwa's socket already handled share-ready and is waiting
 * The server relays share-viewer-join to Vishwa → Vishwa sends offer ✓
 * BUT: The offer was sent BEFORE Ammu's PC was ready to receive it
 * because Ammu's useScreenShareViewer hook connects asynchronously
 *
 * REAL FIX:
 * 1. Server tracks active sharers per room
 * 2. When viewer joins, server immediately tells them WHO is sharing
 *    via "share-active" event → viewer's hook requests offer
 * 3. Sharer retries offer every 3s until viewer confirms receipt
 * 4. Mobile: clear unsupported message, no silent failure
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";

export type ShareStatus = "idle" | "connecting" | "sharing" | "viewing" | "error" | "unsupported";

export interface UseScreenShareOptions {
  nickname: "Vishwa" | "Ammu";
  isEnabled: boolean;
}

export interface UseScreenShareReturn {
  localStream:   MediaStream | null;
  remoteStream:  MediaStream | null;
  status:        ShareStatus;
  errorMsg:      string | null;
  isSpeakerOn:   boolean;
  toggleSpeaker: () => void;
  stop:          () => void;
}

const SIGNALING_SERVER = "https://camera-sharing-server.onrender.com";
const SHARE_ROOM       = "vishwa-ammu-screenshare-v3";

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "turn:openrelay.metered.ca:80",                username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443",               username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  ],
};

function isScreenShareSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof (navigator.mediaDevices as any).getDisplayMedia === "function"
  );
}

// ── SHARER HOOK ───────────────────────────────────────────────────────────────
export function useScreenShare({ nickname, isEnabled }: UseScreenShareOptions): UseScreenShareReturn {

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [status,      setStatus]      = useState<ShareStatus>("idle");
  const [errorMsg,    setErrorMsg]    = useState<string | null>(null);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);

  const socketRef      = useRef<Socket | null>(null);
  const pcRef          = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const iceCandidateQ  = useRef<RTCIceCandidateInit[]>([]);
  const cancelledRef   = useRef(false);
  const retryRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const viewerReadyRef = useRef(false);

  const stopRetry = () => {
    if (retryRef.current) { clearInterval(retryRef.current); retryRef.current = null; }
  };

  const destroyPC = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.onconnectionstatechange = null;
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }
    iceCandidateQ.current = [];
  }, []);

  const cleanup = useCallback((notify = true) => {
    stopRetry();
    destroyPC();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (socketRef.current) {
      if (notify) socketRef.current.emit("share-off", { room: SHARE_ROOM, from: nickname });
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    cancelledRef.current  = false;
    viewerReadyRef.current = false;
    setLocalStream(null);
    setStatus("idle");
    setErrorMsg(null);
  }, [nickname, destroyPC]);

  const drainICE = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    for (const c of iceCandidateQ.current) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    iceCandidateQ.current = [];
  }, []);

  // Build a fresh PC for each offer attempt
  const buildPC = useCallback((stream: MediaStream): RTCPeerConnection => {
    destroyPC();
    const pc = new RTCPeerConnection(ICE_CONFIG);
    pcRef.current = pc;
    stream.getTracks().forEach(t => {
      pc.addTrack(t, stream);
      console.log("[ScreenShare] Added track:", t.kind, t.label);
    });
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && socketRef.current) {
        socketRef.current.emit("share-ice", { room: SHARE_ROOM, from: nickname, candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      console.log("[ScreenShare Sharer] PC state:", pc.connectionState);
      if (pc.connectionState === "connected") {
        stopRetry();
        setStatus("sharing");
        console.log("[ScreenShare] ✅ Viewer connected!");
      }
      if (pc.connectionState === "failed") pc.restartIce();
    };
    return pc;
  }, [nickname, destroyPC]);

  const sendOffer = useCallback(async (stream: MediaStream) => {
    if (cancelledRef.current) return;
    console.log("[ScreenShare] Sending offer...");
    const pc = buildPC(stream);
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("share-offer", {
        room: SHARE_ROOM, from: nickname, sdp: pc.localDescription,
      });
      console.log("[ScreenShare] Offer sent ✅");
    } catch (err) {
      console.error("[ScreenShare] Offer failed:", err);
    }
  }, [nickname, buildPC]);

  useEffect(() => {
    if (!isEnabled) { cleanup(); return; }
    cancelledRef.current   = false;
    viewerReadyRef.current = false;
    setStatus("connecting");
    setErrorMsg(null);

    if (!isScreenShareSupported()) {
      setStatus("unsupported");
      setErrorMsg("Screen sharing isn't supported on this device. Please use a desktop browser (Chrome, Edge, or Firefox).");
      return;
    }

    const run = async () => {
      let screenStream: MediaStream;
      try {
        screenStream = await (navigator.mediaDevices as any).getDisplayMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
          audio: true,
        });
      } catch (err: any) {
        if (cancelledRef.current) return;
        if (err.name === "NotAllowedError") { setStatus("idle"); return; }
        setStatus("error");
        setErrorMsg("Could not start screen share. Please try again.");
        return;
      }

      if (cancelledRef.current) { screenStream.getTracks().forEach(t => t.stop()); return; }

      localStreamRef.current = screenStream;
      setLocalStream(screenStream);
      setStatus("sharing");

      // When user clicks browser's "Stop sharing" button
      screenStream.getVideoTracks()[0]?.addEventListener("ended", () => {
        console.log("[ScreenShare] Stopped via browser Stop button");
        cleanup(true);
      });

      const socket = io(SIGNALING_SERVER, {
        transports: ["websocket", "polling"],
        reconnectionAttempts: 15,
        reconnectionDelay: 2000,
      });
      socketRef.current = socket;

      socket.on("connect", () => {
        console.log("[ScreenShare Socket] Connected:", socket.id);
        socket.emit("share-join", { room: SHARE_ROOM, user: nickname });
      });

      socket.on("share-joined", () => {
        console.log("[ScreenShare] Joined room — announcing share-active");
        // Tell server we are actively sharing — server stores this
        // and tells any late-joining viewers immediately
        socket.emit("share-active", { room: SHARE_ROOM, from: nickname });

        // Retry offer every 3s until viewer connects
        stopRetry();
        retryRef.current = setInterval(async () => {
          if (cancelledRef.current) { stopRetry(); return; }
          if (pcRef.current?.connectionState === "connected") { stopRetry(); return; }
          if (socket.connected) {
            console.log("[ScreenShare] Retrying share-active...");
            socket.emit("share-active", { room: SHARE_ROOM, from: nickname });
          }
        }, 3000);
      });

      // Viewer is ready → send offer NOW
      socket.on("share-viewer-ready", async ({ from }: { from: string }) => {
        if (from === nickname || cancelledRef.current) return;
        console.log("[ScreenShare] Viewer ready:", from, "— sending offer");
        stopRetry(); // stop retrying, viewer is here
        viewerReadyRef.current = true;
        await sendOffer(screenStream);
      });

      // Viewer's answer
      socket.on("share-answer", async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
        if (cancelledRef.current) return;
        const pc = pcRef.current;
        if (!pc) { console.warn("[ScreenShare] No PC for answer"); return; }
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          await drainICE();
          console.log("[ScreenShare] Answer set — ICE negotiating");
        } catch (err) {
          console.error("[ScreenShare] setRemoteDescription(answer) failed:", err);
        }
      });

      // ICE from viewer
      socket.on("share-ice", async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
        if (from === nickname || !candidate) return;
        const pc = pcRef.current;
        if (!pc) return;
        if (!pc.remoteDescription) { iceCandidateQ.current.push(candidate); return; }
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      });

      // Viewer disconnected
      socket.on("share-off", ({ from }: { from: string }) => {
        if (from === nickname) return;
        console.log("[ScreenShare] Viewer disconnected — waiting for reconnect");
        destroyPC();
        viewerReadyRef.current = false;
        // Re-announce so they can reconnect
        if (socket.connected) socket.emit("share-active", { room: SHARE_ROOM, from: nickname });
      });

      socket.on("connect_error", () => {
        if (!cancelledRef.current) { setStatus("error"); setErrorMsg("Cannot connect to server."); }
      });
    };

    run();

    const onUnload = () => {
      socketRef.current?.emit("share-off", { room: SHARE_ROOM, from: nickname });
      localStreamRef.current?.getTracks().forEach(t => t.stop());
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      cancelledRef.current = true;
      window.removeEventListener("beforeunload", onUnload);
      cleanup();
    };
  }, [isEnabled, nickname]);

  const toggleSpeaker = useCallback(() => setIsSpeakerOn(p => !p), []);
  const stop = useCallback(() => cleanup(true), [cleanup]);

  return { localStream, remoteStream: null, status, errorMsg, isSpeakerOn, toggleSpeaker, stop };
}

// ── VIEWER HOOK ───────────────────────────────────────────────────────────────
export interface UseScreenShareViewerReturn {
  remoteStream:  MediaStream | null;
  status:        ShareStatus;
  sharerName:    string | null;
  isSpeakerOn:   boolean;
  toggleSpeaker: () => void;
  stopViewing:   () => void;
}

export function useScreenShareViewer(nickname: "Vishwa" | "Ammu"): UseScreenShareViewerReturn {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [status,       setStatus]       = useState<ShareStatus>("idle");
  const [sharerName,   setSharerName]   = useState<string | null>(null);
  const [isSpeakerOn,  setIsSpeakerOn]  = useState(true);

  const socketRef      = useRef<Socket | null>(null);
  const pcRef          = useRef<RTCPeerConnection | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const iceCandidateQ  = useRef<RTCIceCandidateInit[]>([]);
  const cancelledRef   = useRef(false);
  const isSpeakerRef   = useRef(true);

  const drainICE = async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    for (const c of iceCandidateQ.current) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    iceCandidateQ.current = [];
  };

  const playAudio = (stream: MediaStream) => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
      try { document.body.removeChild(remoteAudioRef.current); } catch {}
    }
    const audio = document.createElement("audio");
    audio.autoplay    = true;
    audio.playsInline = true;
    audio.muted       = !isSpeakerRef.current;
    audio.volume      = 1.0;
    audio.style.cssText = "position:fixed;width:1px;height:1px;bottom:0;left:0;opacity:0.01;";
    audio.srcObject   = stream;
    document.body.appendChild(audio);
    remoteAudioRef.current = audio;
    audio.play().catch(() => {
      document.addEventListener("click",      () => audio.play().catch(() => {}), { once: true });
      document.addEventListener("touchstart", () => audio.play().catch(() => {}), { once: true });
    });
  };

  const handleOffer = async (from: string, sdp: RTCSessionDescriptionInit, socket: Socket) => {
    console.log("[ScreenShare Viewer] Handling offer from:", from);
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    iceCandidateQ.current = [];

    const pc = new RTCPeerConnection(ICE_CONFIG);
    pcRef.current = pc;

    pc.ontrack = ({ streams, track }) => {
      if (cancelledRef.current) return;
      console.log("[ScreenShare Viewer] ✅ Track received:", track.kind);
      const s = streams[0] ?? new MediaStream([track]);
      if (track.kind === "video") setRemoteStream(s);
      if (track.kind === "audio") playAudio(s);
      setStatus("viewing");
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && socket.connected) {
        socket.emit("share-ice", { room: SHARE_ROOM, from: nickname, candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log("[ScreenShare Viewer] PC state:", s);
      if (s === "disconnected" || s === "failed") {
        setRemoteStream(null);
        setStatus("idle");
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainICE();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("share-answer", { room: SHARE_ROOM, from: nickname, sdp: pc.localDescription });
      console.log("[ScreenShare Viewer] Answer sent ✅");
    } catch (err) {
      console.error("[ScreenShare Viewer] Answer failed:", err);
    }
  };

  useEffect(() => {
    cancelledRef.current = false;

    const socket = io(SIGNALING_SERVER, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: 15,
      reconnectionDelay: 2000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("[ScreenShare Viewer Socket] Connected:", socket.id);
      socket.emit("share-join", { room: SHARE_ROOM, user: nickname });
    });

    socket.on("share-joined", () => {
      console.log("[ScreenShare Viewer] Joined room — signaling viewer-ready");
      // Tell server + sharer we are ready to receive
      socket.emit("share-viewer-ready", { room: SHARE_ROOM, from: nickname });
    });

    // Server tells us someone is ALREADY sharing (we joined late)
    // Trigger: we re-signal readiness so sharer sends us the offer
    socket.on("share-active", ({ from }: { from: string }) => {
      if (from === nickname || cancelledRef.current) return;
      console.log("[ScreenShare Viewer] Active sharer detected:", from, "— signaling ready");
      setSharerName(from);
      setStatus("viewing");
      // Signal we're ready — sharer will send us the offer
      socket.emit("share-viewer-ready", { room: SHARE_ROOM, from: nickname });
    });

    // Receive the actual WebRTC offer from sharer
    socket.on("share-offer", async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      if (from === nickname || cancelledRef.current) return;
      console.log("[ScreenShare Viewer] Offer received from:", from);
      setSharerName(from);
      setStatus("viewing");
      await handleOffer(from, sdp, socket);
    });

    // ICE from sharer
    socket.on("share-ice", async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      if (from === nickname || !candidate) return;
      const pc = pcRef.current;
      if (!pc) return;
      if (!pc.remoteDescription) { iceCandidateQ.current.push(candidate); return; }
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    });

    // Sharer stopped
    socket.on("share-off", ({ from }: { from: string }) => {
      if (from === nickname) return;
      console.log("[ScreenShare Viewer] Sharer stopped");
      setRemoteStream(null);
      setSharerName(null);
      setStatus("idle");
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
        try { document.body.removeChild(remoteAudioRef.current); } catch {}
        remoteAudioRef.current = null;
      }
    });

    return () => {
      cancelledRef.current = true;
      if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
        try { document.body.removeChild(remoteAudioRef.current); } catch {}
        remoteAudioRef.current = null;
      }
      socket.emit("share-off", { room: SHARE_ROOM, from: nickname });
      socket.disconnect();
    };
  }, [nickname]);

  const toggleSpeaker = useCallback(() => {
    setIsSpeakerOn(prev => {
      const next = !prev;
      isSpeakerRef.current = next;
      if (remoteAudioRef.current) remoteAudioRef.current.muted = !next;
      return next;
    });
  }, []);

  const stopViewing = useCallback(() => {
    socketRef.current?.emit("share-off", { room: SHARE_ROOM, from: nickname });
    setRemoteStream(null);
    setSharerName(null);
    setStatus("idle");
  }, [nickname]);

  return { remoteStream, status, sharerName, isSpeakerOn, toggleSpeaker, stopViewing };
}
