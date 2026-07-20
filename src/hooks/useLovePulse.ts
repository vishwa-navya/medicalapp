import { useState, useEffect } from 'react';

interface UseLovePulseArgs {
  isOtherUserOnline: boolean;
  isOtherUserTyping: boolean;
  hasMessages: boolean;
}

/**
 * Love Pulse — premium feature.
 * Activates when partner is online, NOT typing, and there are messages in the chat.
 * The idea: partner opened the chat and is looking at it, but hasn't started typing yet.
 */
export function useLovePulse({ isOtherUserOnline, isOtherUserTyping, hasMessages }: UseLovePulseArgs) {
  const [lovePulseActive, setLovePulseActive] = useState(false);

  useEffect(() => {
    const active = isOtherUserOnline && !isOtherUserTyping && hasMessages;
    setLovePulseActive(active);
  }, [isOtherUserOnline, isOtherUserTyping, hasMessages]);

  return lovePulseActive;
}
