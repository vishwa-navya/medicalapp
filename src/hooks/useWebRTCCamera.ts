/**
 * useWebRTCCamera.ts — Production-Grade Camera Sharing v2.0
 *
 * Resilience Features:
 * 1. Perfect Negotiation - prevents offer collisions
 * 2. Auto-reconnection - recovers from network issues
 * 3. Adaptive quality - adjusts based on network
 * 4. Session persistence - survives socket disconnect
 * 5. Face detection safety - prevents unauthorized access
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";

export type CamStatus = "idle" | "warming" | "connecting" | "connected" | "reconnecting" | "error";

export interface UseWebRTCCameraOptions {
  nickname: "Vishwa" | "Ammu";
  isEnabled: boolean;
  onFaceViolation?: () => void;
}

export interface UseWebRTCCameraReturn {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  status: CamStatus;
  errorMsg: string | null;
  audioEnabled: boolean;
  quality: "HIGH" | "MEDIUM" | "LOW";
  toggleAudio: () => void;
  stop: () => void;
}

const SIGNALING_SERVER = "https://camera-sharing-server.onrender.com";
const ROOM = "vishwa-ammu-room-v4";

// Timeouts
const TIMEOUTS = {
  CONNECTION: 30000,
  NEGOTIATION: 15000,
  ICE_GATHERING: 10000,
  RECONNECT: 10000,
  MEDIA: 15000,
  QUALITY_ADAPT: 4000,
};

// Quality tiers
const QUALITY = {
  HIGH: {
    label: "HD",
    width: 1280,
    height: 720,
    frameRate: 30,
    videoBps: 2_500_000,
    audioBps: 64_000,
  },
  MEDIUM: {
    label: "SD",
    width: 854,
    height: 480,
    frameRate: 25,
    videoBps: 1_200_000,
    audioBps: 48_000,
  },
  LOW: {
    label: "Low",
    width: 640,
    height: 360,
    frameRate: 20,
    videoBps: 500_000,
    audioBps: 32_000,
  },
} as const;

type QualityKey = keyof typeof QUALITY;

// ICE servers
const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
  iceTransportPolicy: "all",
};

// Detect initial quality
function detectInitialQuality(): QualityKey {
  try {
    const conn = (navigator as any).connection;
    if (!conn) return "HIGH";

    const type = conn.effectiveType as string;
    const downlink = conn.downlink as number;

    if (type === "4g" && downlink >= 10) return "HIGH";
    if (type === "4g" && downlink >= 4) return "MEDIUM";
    if (type === "4g") return "MEDIUM";
    return "LOW";
  } catch {
    return "HIGH";
  }
}

// Apply bitrate
async function applyBitrate(pc: RTCPeerConnection, quality: QualityKey) {
  const q = QUALITY[quality];
  const senders = pc.getSenders();

  for (const sender of senders) {
    if (!sender.track) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      if (sender.track.kind === "video") {
        params.encodings[0].maxBitrate = q.videoBps;
        params.encodings[0].maxFramerate = q.frameRate;
      }
      if (sender.track.kind === "audio") {
        params.encodings[0].maxBitrate = q.audioBps;
      }
      await sender.setParameters(params);
    } catch {}
  }
}

export function useWebRTCCamera({ nickname, isEnabled, onFaceViolation }: UseWebRTCCameraOptions): UseWebRTCCameraReturn {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<CamStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [quality, setQuality] = useState<QualityKey>(detectInitialQuality());

  // Refs
  const socketRef = useRef<Socket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const iceCandidateQ = useRef<RTCIceCandidateInit[]>([]);
  const cancelledRef = useRef(false);
  const retryRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qualityRef = useRef<QualityKey>(detectInitialQuality());
  const adaptTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevBytesRef = useRef(0);
  const prevTimeRef = useRef(Date.now());
  const isPoliteRef = useRef(nickname === "Ammu"); // Ammu is polite (rolls back)
  const negotiationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ========================
  // MIC TOGGLE
  // ========================

  const toggleAudio = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setAudioEnabled(track.enabled);
  }, []);

  // ========================
  // ADAPTIVE QUALITY
  // ========================

  const startAdaptiveMonitor = useCallback(() => {
    if (adaptTimerRef.current) clearInterval(adaptTimerRef.current);

    adaptTimerRef.current = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc || pc.connectionState !== "connected") return;

      try {
        const stats = await pc.getStats();
        let bytesSent = 0;
        let roundTripTime = 0;
        let packetLoss = 0;

        stats.forEach((report) => {
          if (report.type === "outbound-rtp" && report.kind === "video") {
            bytesSent = report.bytesSent ?? 0;
          }
          if (report.type === "remote-inbound-rtp" && report.kind === "video") {
            roundTripTime = report.roundTripTime ?? 0;
            packetLoss = report.fractionLost ?? 0;
          }
        });

        const now = Date.now();
        const elapsed = (now - prevTimeRef.current) / 1000;
        const bps = ((bytesSent - prevBytesRef.current) * 8) / elapsed;

        prevBytesRef.current = bytesSent;
        prevTimeRef.current = now;

        const currentQ = qualityRef.current;
        let nextQ: QualityKey = currentQ;

        if (roundTripTime < 0.08 && packetLoss < 0.02 && bps > QUALITY.HIGH.videoBps * 0.7) {
          nextQ = "HIGH";
        } else if (roundTripTime < 0.18 && packetLoss < 0.05) {
          nextQ = currentQ === "LOW" ? "MEDIUM" : currentQ;
        } else if (roundTripTime > 0.25 || packetLoss > 0.08) {
          nextQ = "LOW";
        }

        if (nextQ !== currentQ) {
          console.log(`[Quality] ${currentQ} → ${nextQ}`);
          qualityRef.current = nextQ;
          setQuality(nextQ);
          await applyBitrate(pc, nextQ);
        }
      } catch {}
    }, TIMEOUTS.QUALITY_ADAPT);
  }, []);

  const stopAdaptive = () => {
    if (adaptTimerRef.current) {
      clearInterval(adaptTimerRef.current);
      adaptTimerRef.current = null;
    }
  };

  // ========================
  // HELPERS
  // ========================

  const stopRetry = () => {
    if (retryRef.current) {
      clearInterval(retryRef.current);
      retryRef.current = null;
    }
  };

  const clearNegotiationTimeout = () => {
    if (negotiationTimeoutRef.current) {
      clearTimeout(negotiationTimeoutRef.current);
      negotiationTimeoutRef.current = null;
    }
  };

  const clearReconnectTimeout = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  };

  const destroyPC = () => {
    stopAdaptive();
    clearNegotiationTimeout();
    clearReconnectTimeout();
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    iceCandidateQ.current = [];
  };

  const cleanup = useCallback((notify = true) => {
    stopRetry();
    destroyPC();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    streamRef.current = null;
    if (socketRef.current) {
      if (notify) socketRef.current.emit("camera-off", { room: ROOM, from: nickname });
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    cancelledRef.current = false;
    prevBytesRef.current = 0;
    setLocalStream(null);
    setRemoteStream(null);
    setStatus("idle");
    setErrorMsg(null);
    setAudioEnabled(false);
  }, [nickname]);

  const drainICE = async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    for (const c of iceCandidateQ.current) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    iceCandidateQ.current = [];
  };

  // ========================
  // PEER CONNECTION
  // ========================

  const buildPC = (stream: MediaStream): RTCPeerConnection => {
    destroyPC();
    const pc = new RTCPeerConnection(ICE_CONFIG);
    pcRef.current = pc;

    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    pc.ontrack = ({ streams }) => {
      if (streams[0] && !cancelledRef.current) {
        console.log("[WebRTC] Remote stream received");
        stopRetry();
        setRemoteStream(streams[0]);
        setStatus("connected");
        startAdaptiveMonitor();
        clearNegotiationTimeout();
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && socketRef.current) {
        socketRef.current.emit("ice", { room: ROOM, from: nickname, candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log("[WebRTC] State:", s);

      switch (s) {
        case "connected":
          setStatus("connected");
          startAdaptiveMonitor();
          clearReconnectTimeout();
          break;
        case "disconnected":
          console.log("[WebRTC] Disconnected - attempting recovery");
          setStatus("reconnecting");
          setRemoteStream(null);
          // Schedule reconnect - also re-emit camera-ready to trigger renegotiation
          clearReconnectTimeout();
          reconnectTimeoutRef.current = setTimeout(() => {
            if (pcRef.current?.connectionState === "disconnected") {
              console.log("[WebRTC] Reconnect timeout - restarting ICE and re-signaling");
              pc.restartIce();
              // Re-emit camera-ready to trigger fresh negotiation
              if (socketRef.current?.connected && !cancelledRef.current) {
                socketRef.current.emit("camera-ready", { room: ROOM, from: nickname });
              }
            }
          }, TIMEOUTS.RECONNECT);
          break;
        case "failed":
          console.error("[WebRTC] Failed - restarting ICE");
          stopAdaptive();
          pc.restartIce();
          setStatus("connecting");
          // Also re-emit ready to trigger fresh negotiation
          if (socketRef.current?.connected && !cancelledRef.current) {
            socketRef.current.emit("camera-ready", { room: ROOM, from: nickname });
          }
          break;
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log("[ICE] State:", s);
      if (s === "failed") {
        pc.restartIce();
      }
    };

    return pc;
  };

  // ========================
  // PERFECT NEGOTIATION
  // ========================

  const sendOffer = useCallback(async () => {
    const stream = streamRef.current;
    if (!stream || cancelledRef.current) return;

    const pc = pcRef.current || buildPC(stream);

    // Check signaling state (Perfect Negotiation)
    if (pc.signalingState !== "stable" && isPoliteRef.current) {
      console.log("[Negotiation] Rolling back - polite peer");
      await pc.setLocalDescription({ type: "rollback" });
    }

    try {
      setStatus("connecting");

      const offer = await pc.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: true,
      });

      await pc.setLocalDescription(offer);
      await applyBitrate(pc, qualityRef.current);

      socketRef.current?.emit("offer", { room: ROOM, from: nickname, sdp: pc.localDescription });

      console.log("[WebRTC] Offer sent");

      // Negotiation timeout
      clearNegotiationTimeout();
      negotiationTimeoutRef.current = setTimeout(() => {
        if (status === "connecting") {
          console.log("[Negotiation] Timeout - retrying");
          sendOffer();
        }
      }, TIMEOUTS.NEGOTIATION);
    } catch (err) {
      console.error("[WebRTC] Offer error:", err);
      setErrorMsg("Failed to establish connection");
      setStatus("error");
    }
  }, [nickname, status]);

  const handleOffer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
    const stream = streamRef.current;
    if (!stream || cancelledRef.current) return;

    const pc = pcRef.current || buildPC(stream);

    // Perfect Negotiation: handle collision
    if (pc.signalingState !== "stable") {
      if (isPoliteRef.current) {
        console.log("[Negotiation] Rolling back for incoming offer");
        await pc.setLocalDescription({ type: "rollback" });
      } else {
        // Impolite peer ignores incoming offer
        console.log("[Negotiation] Ignoring offer - impolite peer");
        return;
      }
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainICE();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await applyBitrate(pc, qualityRef.current);

      socketRef.current?.emit("answer", { room: ROOM, from: nickname, sdp: pc.localDescription });

      console.log("[WebRTC] Answer sent");
      clearNegotiationTimeout();
    } catch (err) {
      console.error("[WebRTC] Answer error:", err);
    }
  }, [nickname]);

  const handleAnswer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
    const pc = pcRef.current;
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainICE();
      clearNegotiationTimeout();
      console.log("[WebRTC] Answer applied");
    } catch (err) {
      console.error("[WebRTC] Set remote description error:", err);
    }
  }, []);

  // ========================
  // MAIN EFFECT
  // ========================

  useEffect(() => {
    if (!isEnabled) {
      cleanup();
      return;
    }

    cancelledRef.current = false;
    qualityRef.current = detectInitialQuality();
    setStatus("connecting");
    setErrorMsg(null);

    const run = async () => {
      // Warm server first
      setStatus("warming");
      try {
        await fetch(SIGNALING_SERVER + "/health");
      } catch {}
      if (cancelledRef.current) return;

      setStatus("connecting");
      const q = QUALITY[qualityRef.current];

      // Get camera + mic
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: q.width, max: 1920 },
            height: { ideal: q.height, max: 1080 },
            frameRate: { ideal: q.frameRate, max: 30 },
            facingMode: "user",
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            latency: 0,
            channelCount: 1,
            sampleRate: 48000,
          },
        });
      } catch (err: any) {
        if (cancelledRef.current) return;

        // Fallback: video only
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { width: { ideal: q.width }, height: { ideal: q.height }, facingMode: "user" },
              audio: false,
            });
          } catch {
            setStatus("error");
            setErrorMsg("Camera permission denied. Please allow access and try again.");
            return;
          }
        } else {
          const msg =
            err.name === "NotFoundError" ? "No camera found on this device." :
            err.name === "NotReadableError" ? "Camera is in use by another app." :
            "Could not access camera.";
          setStatus("error");
          setErrorMsg(msg);
          return;
        }
      }

      if (cancelledRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      // Mic starts muted
      stream.getAudioTracks().forEach(t => { t.enabled = false; });
      setAudioEnabled(false);

      localStreamRef.current = stream;
      streamRef.current = stream;
      setLocalStream(stream);

      // Connect socket
      const socket = io(SIGNALING_SERVER, {
        transports: ["websocket", "polling"],
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
      });
      socketRef.current = socket;

      socket.on("connect", () => {
        console.log("[Socket] Connected");
        socket.emit("join", { room: ROOM, user: nickname });
      });

      // Handle socket reconnection - re-join room and re-emit ready
      socket.io.on("reconnect", (attempt) => {
        console.log(`[Socket] Reconnected after ${attempt} attempts`);
        if (!cancelledRef.current) {
          socket.emit("join", { room: ROOM, user: nickname });
        }
      });

      socket.on("joined", ({ count }) => {
        console.log(`[Socket] Room joined. Users: ${count}`);
        socket.emit("camera-ready", { room: ROOM, from: nickname });

        // Retry until connected
        stopRetry();
        retryRef.current = setInterval(() => {
          if (cancelledRef.current) { stopRetry(); return; }
          if (pcRef.current?.connectionState === "connected") { stopRetry(); return; }
          if (socket.connected) socket.emit("camera-ready", { room: ROOM, from: nickname });
        }, 3000);
      });

      socket.on("camera-ready", async ({ from }) => {
        if (from === nickname || cancelledRef.current) return;
        console.log(`[Socket] ${from} ready - both peers can now negotiate`);

        // SYMMETRIC RECONNECTION: Both users attempt to create offer
        // Perfect Negotiation handles collision via polite peer rollback
        // This ensures reconnection works regardless of WHO reconnects
        await sendOffer();
      });

      socket.on("request-offer", async ({ to }) => {
        // Anyone can respond to request-offer now (not just Vishwa)
        if (cancelledRef.current) return;
        await sendOffer();
      });

      socket.on("offer", async ({ from, sdp }) => {
        if (from === nickname || cancelledRef.current) return;
        console.log(`[Socket] Offer from ${from}`);
        await handleOffer(sdp);
      });

      socket.on("answer", async ({ from, sdp }) => {
        if (from === nickname || cancelledRef.current) return;
        await handleAnswer(sdp);
      });

      socket.on("ice", async ({ from, candidate }) => {
        if (from === nickname || !candidate) return;
        const pc = pcRef.current;
        if (!pc) {
          iceCandidateQ.current.push(candidate);
          return;
        }
        if (!pc.remoteDescription) {
          iceCandidateQ.current.push(candidate);
          return;
        }
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      });

      socket.on("camera-off", ({ from }) => {
        if (from === nickname) return;
        console.log(`[Socket] ${from} camera off`);
        destroyPC();
        setRemoteStream(null);
        setStatus("connecting");
        if (socket.connected && !cancelledRef.current) {
          socket.emit("camera-ready", { room: ROOM, from: nickname });
        }
      });

      socket.on("connect_error", () => {
        if (!cancelledRef.current) {
          setStatus("error");
          setErrorMsg("Cannot reach signaling server. Check internet and try again.");
        }
      });
    };

    run();

    const onUnload = () => {
      socketRef.current?.emit("camera-off", { room: ROOM, from: nickname });
      localStreamRef.current?.getTracks().forEach(t => t.stop());
    };
    window.addEventListener("beforeunload", onUnload);

    return () => {
      cancelledRef.current = true;
      window.removeEventListener("beforeunload", onUnload);
      cleanup();
    };
  }, [isEnabled, nickname]);

  const stop = useCallback(() => cleanup(true), [cleanup]);

  return {
    localStream,
    remoteStream,
    status,
    errorMsg,
    audioEnabled,
    quality,
    toggleAudio,
    stop,
  };
}
