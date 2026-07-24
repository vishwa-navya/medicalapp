    }
  }, [nickname, chatId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      stopTyping();
    };
  }, [stopTyping]);

  return { handleTyping, stopTyping };
}

// Hook to LISTEN for other user's typing status
export function useTypingListener(
  otherUser: 'Vishwa' | 'Ammu',
  chatId: string = 'privateMessages',
  enabled: boolean = true
) {
  const [isOtherUserTyping, setIsOtherUserTyping] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const socket = io(SIGNALING_SERVER, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('register', { user: otherUser === 'Vishwa' ? 'Ammu' : 'Vishwa', callType: 'typing-listener' });
    });

    socket.on('typing-update', (data: { user: string; isTyping: boolean; chatId: string; timestamp: number }) => {
      if (data.user === otherUser && data.chatId === chatId) {
        setIsOtherUserTyping(data.isTyping);

        // Auto-clear after 3 seconds (safety)
        if (data.isTyping) {
          setTimeout(() => {
            setIsOtherUserTyping(false);
          }, 3000);
        }
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [otherUser, chatId, enabled]);

  return isOtherUserTyping;
}
