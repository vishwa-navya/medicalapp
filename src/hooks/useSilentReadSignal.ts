import { useState, useEffect, useRef } from 'react';

interface UseSilentReadSignalArgs {
  messages: any[];
  nickname: 'Vishwa' | 'Ammu';
  otherUser: 'Vishwa' | 'Ammu';
}

interface SilentReadSignalState {
  silentReadActive: boolean;
  targetMessageId: string | null;
}

const SILENT_READ_DELAY_MS = 30_000;

/**
 * Silent Read Signal — premium feature.
 * Detects when the other user has read your latest message but hasn't replied
 * within 30 seconds. Returns the target message ID so the seen-dots can ripple.
 */
export function useSilentReadSignal({ messages, nickname, otherUser }: UseSilentReadSignalArgs): SilentReadSignalState {
  const [state, setState] = useState<SilentReadSignalState>({ silentReadActive: false, targetMessageId: null });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (!messages || messages.length === 0) {
      setState({ silentReadActive: false, targetMessageId: null });
      return;
    }

    // messages are ordered desc (newest first). Find my last message.
    const myLastMsg = messages.find((m) => m.by === nickname);
    if (!myLastMsg) {
      setState({ silentReadActive: false, targetMessageId: null });
      return;
    }

    // Check if partner has seen it
    const isSeenByOther = (myLastMsg.seenBy || []).includes(otherUser);
    if (!isSeenByOther) {
      setState({ silentReadActive: false, targetMessageId: null });
      return;
    }

    // Check if partner has replied after my message (newer message from them)
    const myMsgIndex = messages.indexOf(myLastMsg);
    const hasPartnerReplied = messages.slice(0, myMsgIndex).some((m) => m.by === otherUser);
    if (hasPartnerReplied) {
      setState({ silentReadActive: false, targetMessageId: null });
      return;
    }

    // Partner has seen but not replied. Start the 30s timer.
    setState({ silentReadActive: false, targetMessageId: null });

    timerRef.current = setTimeout(() => {
      setState({ silentReadActive: true, targetMessageId: myLastMsg.id });
    }, SILENT_READ_DELAY_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [messages, nickname, otherUser]);

  return state;
}
