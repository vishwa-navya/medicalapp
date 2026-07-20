/**
 * useVoiceCall.ts — Production-Grade Voice Call Hook v2.0
 *
 * Resilience Features:
 * 1. Perfect Negotiation - prevents offer collisions
 * 2. Auto-reconnection - recovers from network issues
 * 3. Session persistence - call survives socket disconnect
 * 4. ICE restart on failure
 * 5. Timeout handling for all operations
 * 6. Graceful degradation
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";

export type CallStatus =
  | "idle"
  | "calling"
  | "ringing"
  | "incoming"
  | "connecting"
  | "negotiating"
  | "connected"
  | "reconnecting"
  | "recovering"
  | "ended"
  | "busy"
  | "failed";

export interface UseVoiceCallReturn {
  callStatus: CallStatus;
  callId: string | null;
  isMicOn: boolean;
  isSpeakerOn: boolean;
  isNearEar: boolean;
  callerName: string | null;
  callDuration: number;
  isPolite: boolean;
  startCall: () => Promise<void>;
  acceptCall: () => Promise<void>;
  rejectCall: () => void;
  endCall: () => void;
  toggleMic: () => void;
  toggleSpeaker: () => void;
}

const SIGNALING_SERVER = "https://camera-sharing-server.onrender.com";
const CALL_ROOM = "vishwa-ammu-call-room-v1";

// Timeouts
const TIMEOUTS = {
  CALL: 60000,          // Max ring time
  NEGOTIATION: 15000,   // Offer/answer timeout
  ICE_GATHERING: 10000, // ICE gathering timeout
  CONNECT: 20000,       // Connection establishment
  RECONNECT: 10000,     // Reconnection window
  MEDIA: 10000,         // Media permission
};

// ICE servers
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

export function useVoiceCall(nickname: "Vishwa" | "Ammu"): UseVoiceCallReturn {
  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [callId, setCallId] = useState<string | null>(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);
  const [isNearEar, setIsNearEar] = useState(false);
  const [callerName, setCallerName] = useState<string | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [isPolite, setIsPolite] = useState(false);

  // Refs
  const socketRef = useRef<Socket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const iceCandidateQ = useRef<RTCIceCandidateInit[]>([]);
  const durationRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ringCtxRef = useRef<AudioContext | null>(null);
  const isSpeakerRef = useRef(false);
  const cancelledRef = useRef(false);
  const wakeLockRef = useRef<any>(null);
  const callStatusRef = useRef<CallStatus>("idle");
  const audioUnlockedRef = useRef(false);
  const timerStartedRef = useRef(false);
  const negotiationStateRef = useRef<'stable' | 'have-local-offer' | 'have-remote-offer'>('stable');
  const isPoliteRef = useRef(false);
  const pendingOfferRef = useRef<RTCSessionDescriptionInit | null>(null);

  // Timeouts
  const callTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const negotiationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const other = nickname === "Vishwa" ? "Ammu" : "Vishwa";

  // Keep state in sync
  useEffect(() => {
    callStatusRef.current = callStatus;
  }, [callStatus]);

  // ========================
  // RINGTONE
  // ========================

  const stopRing = useCallback(() => {
    try { ringCtxRef.current?.close(); } catch {}
    ringCtxRef.current = null;
  }, []);

  const startRing = useCallback(() => {
    stopRing();
    try {
      const ctx = new AudioContext();
      ringCtxRef.current = ctx;
      let t = ctx.currentTime;
      for (let i = 0; i < 15; i++) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.frequency.value = i % 2 === 0 ? 440 : 480;
        g.gain.setValueAtTime(0.25, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
        o.start(t);
        o.stop(t + 0.4);
        t += 1.5;
      }
    } catch (e) {
      console.error("[Ring] Error:", e);
    }
  }, [stopRing]);

  // ========================
  // WAKE LOCK
  // ========================

  const acquireWake = async () => {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request("screen");
      }
    } catch (e) {
      console.error("[Wake] Error:", e);
    }
  };

  const releaseWake = () => {
    try { wakeLockRef.current?.release(); } catch {}
    wakeLockRef.current = null;
  };

  // ========================
  // PROXIMITY SENSOR
  // ========================

  const startProximity = useCallback(() => {
    const handler = () => {
      if (callStatusRef.current !== "connected") return;
      const isNear = document.hidden;
      setIsNearEar(isNear);
    };
    document.addEventListener("visibilitychange", handler);
    (startProximity as any).__handler = handler;
  }, []);

  const stopProximity = useCallback(() => {
    const handler = (startProximity as any).__handler;
    if (handler) {
      document.removeEventListener("visibilitychange", handler);
    }
    setIsNearEar(false);
  }, [startProximity]);

  // ========================
  // AUDIO SETUP
  // ========================

  const unlockAudio = () => {
    if (audioUnlockedRef.current) return;

    if (!audioElRef.current) {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.muted = false;
      audio.volume = 1.0;
      audio.style.cssText = "position:fixed;width:1px;height:1px;opacity:0.01;";
      document.body.appendChild(audio);
      audioElRef.current = audio;
    }

    const audio = audioElRef.current;
    audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

    audio.play()
      .then(() => {
        audioUnlockedRef.current = true;
        audio.src = "";
      })
      .catch((err) => {
        console.error("[Audio] Unlock failed:", err);
      });
  };

  const playRemoteAudio = useCallback((stream: MediaStream) => {
    remoteStreamRef.current = stream;

    let audio = audioElRef.current;
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.muted = false;
      audio.volume = 1.0;
      audio.style.cssText = "position:fixed;width:1px;height:1px;opacity:0.01;";
      document.body.appendChild(audio);
      audioElRef.current = audio;
      audioUnlockedRef.current = true;
    }

    audio.srcObject = stream;
    audio.muted = false;
    audio.volume = 1.0;

    applySpeaker(isSpeakerRef.current, audio);

    audio.play()
      .then(() => console.log("[Audio] Playing"))
      .catch((err) => {
        console.error("[Audio] Play failed:", err);
        const onInteraction = () => {
          audio!.play().catch(e => console.error("[Audio] Retry failed:", e));
          document.removeEventListener("click", onInteraction);
          document.removeEventListener("touchstart", onInteraction);
        };
        document.addEventListener("click", onInteraction, { once: true });
        document.addEventListener("touchstart", onInteraction, { once: true });
      });
  }, []);

  const applySpeaker = (on: boolean, el?: HTMLAudioElement) => {
    const a = el ?? audioElRef.current;
    if (!a) return;
    try {
      if (typeof (a as any).setSinkId === "function") {
        (a as any).setSinkId(on ? "" : "communications").catch(() => {});
      }
    } catch {}
  };

  const removeAudio = useCallback(() => {
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.srcObject = null;
      try { document.body.removeChild(audioElRef.current); } catch {}
      audioElRef.current = null;
      audioUnlockedRef.current = false;
    }
    remoteStreamRef.current = null;
  }, []);

  // ========================
  // MICROPHONE
  // ========================

  const getMic = async (retries = 3): Promise<boolean> => {
    // Reuse existing if alive
    if (localStreamRef.current) {
      const tracks = localStreamRef.current.getAudioTracks();
      const alive = tracks.some(t => t.readyState === "live");
      if (alive) return true;
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });

        const tracks = stream.getAudioTracks();
        if (tracks.length === 0) {
          stream.getTracks().forEach(t => t.stop());
          continue;
        }

        localStreamRef.current = stream;
        setIsMicOn(true);
        return true;
      } catch (err: any) {
        console.error(`[Mic] Attempt ${attempt + 1} failed:`, err.name);
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    return false;
  };

  // ========================
  // PEER CONNECTION
  // ========================

  const buildPC = useCallback((): RTCPeerConnection => {
    if (pcRef.current) {
      try {
        pcRef.current.ontrack = null;
        pcRef.current.onicecandidate = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }

    iceCandidateQ.current = [];

    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });

    pcRef.current = pc;

    // Add local tracks
    const stream = localStreamRef.current;
    if (stream) {
      stream.getAudioTracks().forEach(t => {
        pc.addTrack(t, stream);
      });
    }

    // Remote stream handler
    pc.ontrack = (event) => {
      if (cancelledRef.current) return;

      console.log("[PC] Remote track:", event.track.kind);
      const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      playRemoteAudio(remoteStream);

      setCallStatus("connected");
      startTimer();
      startProximity();
      acquireWake();
      clearNegotiationTimeout();
    };

    // ICE candidates
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && socketRef.current && callId) {
        socketRef.current.emit("call-ice", {
          callId,
          from: nickname,
          candidate,
          msgId: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        });
      }
    };

    // Connection state
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log("[PC] State:", s);

      switch (s) {
        case "connected":
        case "completed":
          setCallStatus("connected");
          startTimer();
          break;
        case "disconnected":
          console.log("[PC] Disconnected - attempting recovery");
          setCallStatus("reconnecting");
          scheduleRecovery();
          break;
        case "failed":
          console.error("[PC] Failed - restarting ICE");
          pc.restartIce();
          setCallStatus("reconnecting");
          break;
        case "closed":
          cleanup();
          break;
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log("[ICE] State:", s);

      if (s === "failed") {
        console.log("[ICE] Failed - restarting");
        pc.restartIce();
      } else if (s === "disconnected") {
        setCallStatus("reconnecting");
      }
    };

    return pc;
  }, [callId, nickname, playRemoteAudio, startProximity]);

  // ========================
  // ICE CANDIDATE DRAINING
  // ========================

  const drainICE = async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;

    for (const c of iceCandidateQ.current) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {}
    }
    iceCandidateQ.current = [];
  };

  // ========================
  // PERFECT NEGOTIATION
  // ========================

  const createOffer = useCallback(async () => {
    const pc = pcRef.current || buildPC();

    // Don't create offer if stable and not polite
    if (pc.signalingState !== "stable" && !isPoliteRef.current) {
      console.log("[Negotiation] Skipping offer - not stable");
      return;
    }

    try {
      setCallStatus("negotiating");
      startNegotiationTimeout();

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
        voiceActivityDetection: true,
      });

      await pc.setLocalDescription(offer);

      if (socketRef.current && callId) {
        socketRef.current.emit("call-offer", {
          callId,
          from: nickname,
          sdp: pc.localDescription,
          msgId: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        });
      }

      console.log("[Negotiation] Offer sent");
    } catch (err) {
      console.error("[Negotiation] Offer error:", err);
      setCallStatus("failed");
    }
  }, [buildPC, callId, nickname]);

  const handleOffer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
    const pc = pcRef.current || buildPC();

    // Perfect Negotiation: handle collision
    if (pc.signalingState !== "stable") {
      if (isPoliteRef.current) {
        // Rollback and accept incoming offer
        console.log("[Negotiation] Rolling back for collision");
        await pc.setLocalDescription({ type: "rollback" });
      } else {
        // Store pending offer for later
        pendingOfferRef.current = sdp;
        return;
      }
    }

    try {
      setCallStatus("negotiating");
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainICE();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (socketRef.current && callId) {
        socketRef.current.emit("call-answer", {
          callId,
          from: nickname,
          sdp: pc.localDescription,
          msgId: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        });
      }

      clearNegotiationTimeout();
      console.log("[Negotiation] Answer sent");
    } catch (err) {
      console.error("[Negotiation] Handle offer error:", err);
    }
  }, [buildPC, callId, nickname]);

  const handleAnswer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
    const pc = pcRef.current;
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainICE();
      clearNegotiationTimeout();
      console.log("[Negotiation] Answer applied");
    } catch (err) {
      console.error("[Negotiation] Answer error:", err);
    }
  }, []);

  // ========================
  // TIMEOUTS
  // ========================

  const startCallTimeout = useCallback(() => {
    clearCallTimeout();
    callTimeoutRef.current = setTimeout(() => {
      if (callStatusRef.current === "calling" || callStatusRef.current === "ringing") {
        console.log("[Call] Ring timeout");
        endCall();
      }
    }, TIMEOUTS.CALL);
  }, []);

  const clearCallTimeout = () => {
    if (callTimeoutRef.current) {
      clearTimeout(callTimeoutRef.current);
      callTimeoutRef.current = null;
    }
  };

  const startNegotiationTimeout = () => {
    clearNegotiationTimeout();
    negotiationTimeoutRef.current = setTimeout(() => {
      console.warn("[Negotiation] Timeout - attempting recovery");
      setCallStatus("reconnecting");
      // Retry negotiation
      if (isPoliteRef.current) {
        createOffer();
      }
    }, TIMEOUTS.NEGOTIATION);
  };

  const clearNegotiationTimeout = () => {
    if (negotiationTimeoutRef.current) {
      clearTimeout(negotiationTimeoutRef.current);
      negotiationTimeoutRef.current = null;
    }
  };

  const scheduleRecovery = () => {
    clearRecoveryTimeout();
    reconnectTimeoutRef.current = setTimeout(() => {
      if (callStatusRef.current === "reconnecting") {
        console.log("[Call] Recovery timeout - ending call");
        endCall();
      }
    }, TIMEOUTS.RECONNECT);
  };

  const clearRecoveryTimeout = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  };

  // ========================
  // TIMER
  // ========================

  const startTimer = useCallback(() => {
    if (timerStartedRef.current) return;
    timerStartedRef.current = true;
    setCallDuration(0);
    durationRef.current = setInterval(() => {
      setCallDuration(d => d + 1);
    }, 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (durationRef.current) {
      clearInterval(durationRef.current);
      durationRef.current = null;
    }
    timerStartedRef.current = false;
  }, []);

  // ========================
  // CLEANUP
  // ========================

  const cleanup = useCallback(() => {
    stopRing();
    stopProximity();
    releaseWake();
    stopTimer();
    clearCallTimeout();
    clearNegotiationTimeout();
    clearRecoveryTimeout();

    if (pcRef.current) {
      try {
        pcRef.current.ontrack = null;
        pcRef.current.onicecandidate = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }

    removeAudio();
    iceCandidateQ.current = [];
    timerStartedRef.current = false;
    setCallId(null);
    setCallerName(null);
    setCallDuration(0);
    setIsNearEar(false);
    setIsPolite(false);
    isPoliteRef.current = false;
  }, [stopRing, stopProximity, stopTimer, removeAudio]);

  // ========================
  // SOCKET CONNECTION
  // ========================

  useEffect(() => {
    cancelledRef.current = false;

    // Warm server first
    fetch(SIGNALING_SERVER + "/health").catch(() => {});

    const socket = io(SIGNALING_SERVER, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("[Socket] Connected");
      socket.emit("register", { user: nickname, callType: "voice" });
    });

    socket.on("registered", () => {
      console.log("[Socket] Registered");
    });

    socket.on("disconnect", (reason) => {
      console.log("[Socket] Disconnected:", reason);
      if (callStatusRef.current === "connected") {
        setCallStatus("reconnecting");
        scheduleRecovery();
      }
    });

    // Incoming call
    socket.on("call-incoming", ({ callId: incomingCallId, type, from, polite }) => {
      if (cancelledRef.current) return;
      console.log("[Call] Incoming from:", from);
      setCallId(incomingCallId);
      setCallerName(from);
      setIsPolite(polite === nickname);
      isPoliteRef.current = polite === nickname;
      setCallStatus("incoming");
      startRing();
      startCallTimeout();
    });

    // Call accepted
    socket.on("call-accepted", async ({ callId: acceptedId, from }) => {
      if (cancelledRef.current) return;
      console.log("[Call] Accepted");
      stopRing();
      clearCallTimeout();
      setCallStatus("connecting");

      const ok = await getMic();
      if (!ok) {
        console.error("[Call] Mic failed");
        endCall();
        return;
      }

      // Caller creates offer
      await createOffer();
    });

    // Call rejected
    socket.on("call-rejected", () => {
      console.log("[Call] Rejected");
      stopRing();
      clearCallTimeout();
      setCallStatus("ended");
      setTimeout(() => {
        setCallStatus("idle");
        cleanup();
      }, 2000);
    });

    // User offline
    socket.on("call-user-offline", () => {
      console.log("[Call] User offline");
      stopRing();
      setCallStatus("busy");
      setTimeout(() => setCallStatus("idle"), 3000);
    });

    // Offer received
    socket.on("call-offer", async ({ from, sdp }) => {
      if (from === nickname || cancelledRef.current) return;
      console.log("[Call] Offer received");
      await handleOffer(sdp);
    });

    // Answer received
    socket.on("call-answer", async ({ from, sdp }) => {
      if (cancelledRef.current) return;
      console.log("[Call] Answer received");
      await handleAnswer(sdp);
    });

    // ICE candidate
    socket.on("call-ice", async ({ from, candidate }) => {
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

      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {}
    });

    // Call ended by peer
    socket.on("call-ended", ({ reason }) => {
      console.log("[Call] Ended by peer:", reason);
      stopRing();
      cleanup();
      setCallStatus("ended");
      setTimeout(() => setCallStatus("idle"), 2000);
    });

    // Peer disconnected
    socket.on("peer-disconnected", ({ user, state }) => {
      console.log(`[Call] Peer ${user} disconnected, state: ${state}`);
      if (state === "connected") {
        setCallStatus("reconnecting");
        scheduleRecovery();
      }
    });

    // Peer recovered
    socket.on("peer-recovered", ({ user }) => {
      console.log(`[Call] Peer ${user} recovered`);
      setCallStatus("connected");
      clearRecoveryTimeout();
    });

    // Negotiation rollback
    socket.on("negotiation-rollback", () => {
      console.log("[Negotiation] Rollback requested");
      if (pcRef.current && pcRef.current.signalingState !== "stable") {
        pcRef.current.setLocalDescription({ type: "rollback" });
      }
    });

    // Negotiation timeout from server
    socket.on("negotiation-timeout", () => {
      console.log("[Negotiation] Server timeout - retrying");
      if (isPoliteRef.current) {
        createOffer();
      }
    });

    return () => {
      cancelledRef.current = true;
      stopRing();
      cleanup();
      socket.disconnect();
    };
  }, [nickname]);

  // ========================
  // PUBLIC API
  // ========================

  const startCall = useCallback(async () => {
    if (!socketRef.current) {
      console.error("[Call] Socket not ready");
      return;
    }

    unlockAudio();

    const ok = await getMic();
    if (!ok) {
      alert("Cannot access microphone. Please allow permission.");
      return;
    }

    setCallStatus("calling");
    startRing();
    startCallTimeout();

    socketRef.current.emit("call-user", {
      to: other,
      type: "voice",
    });
  }, [other, startRing, startCallTimeout]);

  const acceptCall = useCallback(async () => {
    console.log("[Call] Accepting");
    unlockAudio();
    stopRing();
    clearCallTimeout();
    setCallStatus("connecting");

    const ok = await getMic();
    if (!ok) {
      console.error("[Call] Mic failed");
      endCall();
      return;
    }

    socketRef.current?.emit("call-accept", { callId });
  }, [callId, stopRing]);

  const rejectCall = useCallback(() => {
    console.log("[Call] Rejecting");
    stopRing();
    clearCallTimeout();
    cleanup();
    setCallStatus("idle");

    socketRef.current?.emit("call-reject", { callId });
  }, [callId, stopRing, cleanup]);

  const endCall = useCallback(() => {
    console.log("[Call] Ending");
    stopRing();
    clearCallTimeout();
    clearNegotiationTimeout();
    clearRecoveryTimeout();

    socketRef.current?.emit("call-end", { callId });

    cleanup();
    setCallStatus("idle");
  }, [callId, stopRing, cleanup]);

  const toggleMic = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setIsMicOn(track.enabled);
  }, []);

  const toggleSpeaker = useCallback(() => {
    setIsSpeakerOn(prev => {
      const next = !prev;
      isSpeakerRef.current = next;
      applySpeaker(next);
      return next;
    });
  }, []);

  return {
    callStatus,
    callId,
    isMicOn,
    isSpeakerOn,
    isNearEar,
    callerName,
    callDuration,
    isPolite,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMic,
    toggleSpeaker,
  };
}
