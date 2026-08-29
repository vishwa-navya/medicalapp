import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BookOpen, Send, LogOut, Trash2, ChevronDown, Sparkles } from 'lucide-react';
import RobotCloud from '../components/RobotCloud';
import TypingIndicator from '../components/TypingIndicator';
import { calculateSpacingForAllMessages } from '../lib/messageSpacing';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  serverTimestamp,
  doc,
  deleteDoc,
} from 'firebase/firestore';
import { db } from '../firebase';

interface Chat1Props {
  nickname: string;
  onLogout: () => void;
}

interface AIMessage {
  id: string;
  text: string;
  by: string; // nickname for user, 'AI' for AI
  type: string;
  ts: any; // Firestore timestamp or Date
  replyTo?: { id: string; text: string; by: string } | null;
}

const CHATBOT_API_URL = 'https://aichatbot2-423j.onrender.com/api/chat';
const CHATBOT_TIMEOUT_MS = 45_000;
const MAX_HISTORY_TURNS = 6;

function Chat1({ nickname, onLogout }: Chat1Props) {
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [message, setMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isAwaitingAIRef = useRef(false);
  const messagesRef = useRef<AIMessage[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // CHANGED: One shared collection for ALL users, instead of a separate
  // collection per nickname (aiChat_a, aiChat_d, ...). Previously, whoever
  // typed a different name on entry got an empty chat, because each name
  // mapped to its own Firestore collection. Now every nickname reads from
  // and writes to the SAME collection, so the conversation is common to
  // everyone no matter what name they enter with.
  const isNicknameReady = typeof nickname === 'string' && nickname.trim().length > 0;
  const collectionName = 'aiChat_shared';

  // Subscribe to Firebase for this user's AI chat history
  useEffect(() => {
    if (!collectionName) {
      // Don't query, don't clear loading, wait for nickname to be ready
      console.log('[Chat1] Waiting for nickname before loading chat history...');
      return;
    }

    console.log('[Chat1] Subscribing to collection:', collectionName);
    setLoading(true);

    const q = query(
      collection(db, collectionName),
      orderBy('ts', 'asc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const loaded = snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        })) as AIMessage[];
        console.log(`[Chat1] Loaded ${loaded.length} messages from ${collectionName}`);
        setMessages(loaded);
        setLoading(false);
      },
      (err) => {
        console.error('[Chat1] Firebase listener error:', err);
        setLoading(false);
      }
    );

    return () => {
      console.log('[Chat1] Unsubscribing from:', collectionName);
      unsubscribe();
    };
  }, [collectionName]);

  const spacingMap = useCallback(() => {
    return calculateSpacingForAllMessages(messages as any);
  }, [messages]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
      setShowScrollButton(!isAtBottom && messages.length > 0);
    };
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [messages.length]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
    return () => clearTimeout(timeout);
  }, [messages, isTyping]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowScrollButton(false);
  };

  const formatMessageTime = (timestamp: any): string => {
    try {
      if (!timestamp) return '';
      let date: Date;
      if (timestamp.toDate && typeof timestamp.toDate === 'function') {
        date = timestamp.toDate();
      } else if (timestamp instanceof Date) {
        date = timestamp;
      } else {
        date = new Date(timestamp);
      }
      if (isNaN(date.getTime())) return '';
      const TZ = 'Asia/Kolkata';
      const dayFmt = new Intl.DateTimeFormat('en-IN', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const isToday = dayFmt.format(date) === dayFmt.format(new Date());
      if (isToday) {
        return new Intl.DateTimeFormat('en-US', {
          timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
        }).format(date);
      }
      return new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
      }).format(date);
    } catch {
      return '';
    }
  };

  const callChatbotAPI = async (userMessage: string): Promise<string> => {
    const history = messagesRef.current
      .slice(-MAX_HISTORY_TURNS * 2)
      .map(m => ({
        role: m.by === 'AI' ? 'assistant' : 'user',
        content: m.text,
      }));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CHATBOT_TIMEOUT_MS);

    try {
      const res = await fetch(CHATBOT_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage, history }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let data: any = {};
      try { data = await res.json(); } catch {}

      if (!res.ok) {
        throw new Error(data?.error || `Server error (${res.status}). Please try again.`);
      }

      if (!data.reply) {
        throw new Error('No response received. Please try again.');
      }

      return data.reply;

    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('The AI is taking too long to respond. Please try again.');
      }
      if (err.message?.includes('fetch')) {
        throw new Error('Could not reach the AI server. It may be waking up. Please try again in a few seconds.');
      }
      throw err;
    }
  };

  // FIX: Guard save function too. Never write to a null/undefined collection
  const saveMessageToFirebase = async (msg: Omit<AIMessage, 'id'>): Promise<string> => {
    if (!collectionName) {
      console.error('[Chat1] Cannot save. collectionName not ready yet');
      throw new Error('Chat not ready yet. Please wait a moment and try again.');
    }
    const docRef = await addDoc(collection(db, collectionName), {
      ...msg,
      ts: serverTimestamp(),
    });
    console.log(`[Chat1] Saved message to ${collectionName}:`, docRef.id);
    return docRef.id;
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const userMessage = message.trim();
    if (!userMessage || isAwaitingAIRef.current) return;

    if (!collectionName) {
      setError('Chat is still loading. Please wait a moment and try again.');
      return;
    }

    setError(null);
    isAwaitingAIRef.current = true;
    setMessage('');

    const userMsgData = {
      text: userMessage,
      by: nickname,
      type: 'text',
      replyTo: null,
    };

    let userId: string;
    try {
      userId = await saveMessageToFirebase(userMsgData);
    } catch (err) {
      console.error('[Chat1] Failed to save user message:', err);
      setError('Failed to save your message. Please try again.');
      isAwaitingAIRef.current = false;
      return;
    }

    setIsTyping(true);

    try {
      const aiText = await callChatbotAPI(userMessage);

      await saveMessageToFirebase({
        text: aiText,
        by: 'AI',
        type: 'text',
        replyTo: { id: userId, text: userMessage, by: nickname },
      });
    } catch (err: any) {
      console.error('[Chat1] Chatbot API error:', err);
      const errMsg = err?.message || 'Something went wrong. Please try again.';
      setError(errMsg);
      try {
        await saveMessageToFirebase({
          text: `Sorry, I couldn't respond right now. ${errMsg}`,
          by: 'AI',
          type: 'text',
          replyTo: { id: userId, text: userMessage, by: nickname },
        });
      } catch {
        // If even the error message fails to save, don't crash. Just show the inline error banner
      }
    } finally {
      setIsTyping(false);
      isAwaitingAIRef.current = false;
      textareaRef.current?.focus();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setMessage(value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (!collectionName) return;
    try {
      await deleteDoc(doc(db, collectionName, messageId));
    } catch (err) {
      console.error('[Chat1] Failed to delete message:', err);
    }
  };

  const handleClearChat = async () => {
    if (!collectionName || messages.length === 0) return;
    if (!window.confirm('Clear all messages in this conversation?')) return;

    for (const msg of messages) {
      try {
        await deleteDoc(doc(db, collectionName, msg.id));
      } catch (err) {
        console.error('[Chat1] Failed to delete message:', err);
      }
    }
    setError(null);
  };

  const spMap = spacingMap();

  return (
    <div className="h-full w-full bg-gradient-to-br from-green-50 via-emerald-50 to-teal-50">
      {/* HEADER, matching Chat2 style exactly */}
      <div className="fixed top-0 left-0 right-0 bg-gradient-to-r from-green-50/95 via-blue-50/95 to-purple-50/95 backdrop-blur-md px-4 py-4 z-50 shadow-lg border-b border-white/30">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-shrink-0 min-w-0">
              <div className="w-11 h-11 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center shadow-lg">
                <BookOpen className="w-6 h-6 text-white" />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm sm:text-lg font-bold bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent truncate">
                  B.Com Study Assistant
                </h1>
                <p className="text-xs text-gray-500 flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-green-500" />
                  AI-powered for commerce students
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 sm:gap-2 flex-shrink-0">
              <button
                onClick={handleClearChat}
                disabled={messages.length === 0}
                className="px-3 py-2 rounded-full text-sm sm:text-xs font-semibold bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Clear conversation"
              >
                <Trash2 className="w-4 h-4" />
              </button>

              <button
                onClick={onLogout}
                className="flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-medium bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">Exit</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Book Background Watermark */}
      <div className="fixed inset-0 flex items-center justify-center pointer-events-none z-0">
        <div className="text-9xl opacity-10 text-gray-500">📚</div>
      </div>

      {/* MESSAGES LIST */}
      <div
        ref={messagesContainerRef}
        className="max-w-4xl mx-auto p-4 relative z-10 h-screen overflow-y-auto"
        style={{ paddingTop: '90px', paddingBottom: '120px' }}
      >
        {loading || !isNicknameReady ? (
          <div className="text-center py-12">
            <div className="text-4xl mb-4">📚</div>
            <p className="text-gray-500">Loading your conversation...</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-12 sm:py-20">
            <div className="text-6xl mb-4">📚💡</div>
            <h2 className="text-xl font-bold text-gray-700 mb-2">Welcome to your B.Com Study Assistant!</h2>
            <p className="text-gray-500 max-w-md mx-auto">
              Ask me anything about accounting, finance, economics, business law, taxation, statistics, and more.
              Paste a paragraph to summarize or explain, or ask for exam-oriented answers.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2 max-w-lg mx-auto">
              {['Explain inflation simply', 'Summarize this paragraph', 'Give me a 5 mark answer on GST', 'Solve this accounting problem'].map(suggestion => (
                <button
                  key={suggestion}
                  onClick={() => {
                    setMessage(suggestion);
                    textareaRef.current?.focus();
                  }}
                  className="px-3 py-1.5 rounded-full text-xs font-medium bg-white/80 text-green-700 border border-green-200 hover:bg-green-50 transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {messages.map((msg) => {
              const isAIMessage = msg.by === 'AI';
              const hasSpacing = spMap[msg.id] || false;

              return (
                <RobotCloud
                  key={msg.id}
                  messageId={msg.id}
                  text={msg.text}
                  isOwn={!isAIMessage}
                  isUser={!isAIMessage}
                  isAI={isAIMessage}
                  type={msg.type}
                  currentUserNickname={nickname}
                  timestamp={formatMessageTime(msg.ts)}
                  replyTo={msg.replyTo}
                  hasSpacing={hasSpacing}
                  onDelete={handleDeleteMessage}
                />
              );
            })}
            {isTyping && <TypingIndicator nickname="AI" />}
            {error && (
              <div className="flex justify-center my-4">
                <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600 max-w-md text-center">
                  {error}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
            <div className="h-24"></div>
          </div>
        )}
      </div>

      {/* Scroll to bottom button */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="fixed bottom-32 right-6 bg-green-500 text-white p-3 rounded-full shadow-lg hover:bg-green-600 transition-all z-40"
          title="Scroll to latest message"
        >
          <ChevronDown className="w-5 h-5" />
        </button>
      )}

      {/* Message Input */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-sm border-t border-green-200 p-4 z-50 shadow-lg">
        <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto">
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <div className="relative">
                <textarea
                  value={message}
                  onChange={handleInputChange}
                  placeholder="Ask me about accounting, economics, taxation, or paste a paragraph to summarize..."
                  className="w-full px-4 py-3 rounded-2xl border border-green-200 focus:border-green-400 focus:ring-2 focus:ring-green-100 outline-none resize-none transition-all bg-white shadow-sm overflow-y-auto"
                  rows={1}
                  style={{
                    minHeight: '48px',
                    maxHeight: '120px',
                    height: 'auto',
                    WebkitOverflowScrolling: 'touch',
                    overscrollBehavior: 'contain',
                  }}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck="false"
                  ref={(el) => {
                    textareaRef.current = el;
                    if (el) {
                      el.style.height = 'auto';
                      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (message.trim() && !isAwaitingAIRef.current) {
                        handleSendMessage(e);
                      }
                    }
                  }}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={!message.trim() || isTyping}
              className="bg-gradient-to-r from-green-500 to-emerald-500 text-white p-3 rounded-full hover:from-green-600 hover:to-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed transform hover:scale-105 transition-all duration-200 shadow-lg hover:shadow-xl z-10"
            >
              <Send className="w-5 h-5" />
            </button>
          </div>
        </form>
      </div>

      {/* Floating Study Icons */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-20 left-5 text-green-200 text-2xl animate-bounce">📚</div>
        <div className="absolute top-40 right-8 text-emerald-200 text-xl animate-pulse">✏️</div>
        <div className="absolute bottom-32 left-12 text-teal-300 text-3xl animate-bounce">📖</div>
        <div className="absolute top-60 right-20 text-green-300 text-2xl animate-pulse">💡</div>
        <div className="absolute bottom-60 left-20 text-emerald-300 text-xl animate-bounce">📝</div>
        <div className="absolute top-80 left-40 text-blue-300 text-2xl animate-pulse">🎓</div>
      </div>
    </div>
  );
}

export default Chat1;
