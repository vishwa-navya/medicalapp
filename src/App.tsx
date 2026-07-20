// src/App.tsx
import React, { useState, useEffect, Component, ReactNode } from 'react';
import { Heart, BookOpen, Check, X, AlertCircle } from 'lucide-react';
import Chat1 from './pages/Chat1';
import Chat2 from './pages/Chat2';
import Chat3 from './pages/Chat3';
import MemoryPage from './components/MemoryPage';
import { requestFCMToken, onForegroundMessage } from './firebase';
import { useSafetyToggle } from './hooks/useSafetyToggle';
import { resetCameraState } from './hooks/useCameraState';

// Server URLs
const SIGNALING_SERVER = 'https://camera-sharing-server.onrender.com';

type Page = 'login' | 'chat1' | 'chat2' | 'chat3' | 'memory';
type Nickname = 'Vishwa' | 'Ammu' | string;

/**
 * Wake up the signaling server (important for Render cold start)
 * Called immediately when app loads
 */
async function wakeUpServer() {
  try {
    console.log('🌅 Warming up signaling server...');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${SIGNALING_SERVER}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wake: true, ts: Date.now() }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      console.log('✅ Signaling server is awake');
    }
  } catch (err: any) {
    // Server might be waking up, that's okay
    console.log('⚠️ Wake-up request sent (server may be starting)');
  }
}

// Global error boundary to prevent white screen crashes
class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }> {
  state = { hasError: false, error: undefined };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-red-900 to-red-700 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md text-center">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-gray-800 mb-2">Something went wrong</h1>
            <p className="text-gray-600 mb-4 text-sm">{this.state.error?.message || 'An unexpected error occurred'}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-2 bg-red-500 text-white rounded-full font-medium hover:bg-red-600 transition"
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Safe FCM initializer — defensive so it won't crash at runtime
 */
async function initializeFCM() {
  try {
    console.log('🔔 Initializing Firebase Cloud Messaging...');
    if (typeof requestFCMToken === 'function') {
      await requestFCMToken();
    } else {
      console.warn('requestFCMToken is not available/exported from ./firebase');
    }

    if (typeof onForegroundMessage === 'function') {
      try {
        onForegroundMessage(() => {
          console.log('📨 Foreground message received');
        });
      } catch (err) {
        console.warn('onForegroundMessage threw:', err);
      }
    } else {
      console.warn('onForegroundMessage is not available/exported from ./firebase');
    }

    console.log('✅ FCM initialization attempt finished');
  } catch (error) {
    console.error('❌ FCM initialization failed:', error);
  }
}

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('login');
  const [nickname, setNickname] = useState<Nickname>('');
  const [inputNickname, setInputNickname] = useState('');
  const { isSafe, toggleSafety, loading: safetyLoading } = useSafetyToggle();

  // 🔔 Setup Notifications (safe)
  useEffect(() => {
    const setupNotifications = async () => {
      try {
        await initializeFCM();
      } catch (err) {
        console.error('Notification setup failed (caught):', err);
      }
    };
    setupNotifications();
  }, []);

  // 🌅 WAKE UP SERVER on app load (critical for Render cold start)
  useEffect(() => {
    wakeUpServer();
    // Also wake up periodically to prevent cold start during use
    const wakeInterval = setInterval(wakeUpServer, 10 * 60 * 1000); // Every 10 minutes
    return () => clearInterval(wakeInterval);
  }, []);

  // 📨 Handle Notification Click (returns to login)
  useEffect(() => {
    const handleNotificationClick = () => {
      setCurrentPage('login');
      setNickname('');
      setInputNickname('');
    };

    if ('serviceWorker' in navigator && navigator.serviceWorker.addEventListener) {
      navigator.serviceWorker.addEventListener('message', handleNotificationClick);
      return () => {
        if (navigator.serviceWorker.removeEventListener) {
          navigator.serviceWorker.removeEventListener('message', handleNotificationClick);
        }
      };
    }
    // fallback: no service worker available — nothing to do
  }, []);

  // 🔐 Handle Login
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedNickname = inputNickname.trim().toLowerCase();

    // If safety is OFF (blocked) -> go to chat1 (AI)
    if (!isSafe) {
      setNickname(inputNickname.trim());
      setCurrentPage('chat1');
      return;
    }

    // Normal behaviour when safety is ON
    if (trimmedNickname === 'vishwa' || trimmedNickname === 'ammu') {
      setNickname(trimmedNickname === 'vishwa' ? 'Vishwa' : 'Ammu');
      setCurrentPage('chat2');
    } else {
      setNickname(inputNickname.trim());
      setCurrentPage('chat1');
    }
  };

  // Quick login buttons (books)
  const loginAsVishwa = () => {
    if (!isSafe) return; // blocked
    setNickname('Vishwa');
    setCurrentPage('chat2');
  };

  const loginAsAmmu = () => {
    if (!isSafe) return; // blocked
    setNickname('Ammu');
    setCurrentPage('chat2');
  };

  const handleLogout = () => {
    if (nickname) {
      try {
        resetCameraState(nickname);
      } catch (err) {
        console.warn('resetCameraState failed:', err);
      }
    }
    setCurrentPage('login');
    setNickname('');
    setInputNickname('');
  };

  const handleSwitchToAIChat = () => setCurrentPage('chat1');
  const handleSwitchToChat2 = () => setCurrentPage('chat2');
  const handleSwitchToChat3 = () => setCurrentPage('chat3');
  const handleOpenMemory = () => setCurrentPage('memory');

  // 🧭 LOGIN PAGE
  if (currentPage === 'login') {
    return (
      <div
        className="w-full bg-gradient-to-br from-pink-50 via-rose-50 to-red-50
                   flex items-center justify-center p-4 relative overflow-hidden"
        style={{ height: 'calc(var(--vh, 1vh) * 100)' }}
      >
        {/* Floating Emojis */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-10 left-4 text-blue-200 text-3xl md:text-4xl animate-pulse">
            🩺
          </div>
          <div className="absolute top-32 right-4 text-green-200 text-2xl md:text-3xl animate-bounce">
            👨‍⚕️
          </div>
          <div className="absolute bottom-32 left-8 text-purple-300 text-4xl md:text-5xl animate-pulse">
            🩺
          </div>
          <div className="absolute bottom-16 right-4 text-indigo-300 text-xl md:text-2xl animate-bounce">
            👩‍⚕️
          </div>
          <div className="hidden sm:block absolute top-1/2 left-1/4 text-teal-300 text-2xl md:text-3xl animate-pulse">
            🩺
          </div>
          <div className="hidden sm:block absolute top-60 right-10 text-pink-300 text-xl md:text-2xl animate-bounce">
            👨‍⚕️
          </div>
        </div>

        {/* ✅ Safety Toggle Button (plain icon only) */}
        <button
          onClick={toggleSafety}
          disabled={safetyLoading}
          className="fixed bottom-8 left-6 sm:bottom-10 sm:left-10 z-50 transition-transform duration-150 active:scale-95"
          title={isSafe ? 'Tick — normal (Chat2/Chat3 allowed)' : 'Cross — blocked (only Chat1)'}
        >
         {isSafe ? (
  <span className="text-2xl">🩺</span> // ✅ Tick → Stethoscope emoji
) : (
  <span className="text-2xl">💉</span> // ❌ Cross → Injection emoji
)}

        </button>

        {/* 🔲 Login Box */}
        <div
          className="bg-white/90 backdrop-blur-sm rounded-3xl shadow-2xl p-8 w-full max-w-md 
                     border border-pink-200 relative z-10"
        >
          <div className="text-center mb-8">
            {/* 📚 Book Icons */}
            <div className="flex items-center justify-center gap-4 mb-4">
              <BookOpen
                onClick={loginAsAmmu}
                className={`w-8 h-8 text-green-500 m-1 transition-all ${
                  isSafe ? 'cursor-pointer hover:scale-110' : 'opacity-50 cursor-not-allowed'
                }`}
                title={isSafe ? 'Login as Ammu' : 'Blocked - Safety active'}
              />
              <BookOpen
                onClick={loginAsVishwa}
                className={`w-8 h-8 text-blue-500 m-1 transition-all ${
                  isSafe ? 'cursor-pointer hover:scale-110' : 'opacity-50 cursor-not-allowed'
                }`}
                title={isSafe ? 'Login as Vishwa' : 'Blocked - Safety active'}
              />
            </div>

            <h1
              className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-green-600 
                           bg-clip-text text-transparent mb-2"
            >
              Doctors Study Portal
            </h1>
            <p className="text-gray-600">
              Your AI teacher is here to guide you on your journey to becoming a doctor
            </p>
          </div>

          {/* 🧑‍⚕️ Name Input */}
          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label className="block text-gray-700 font-medium mb-2">Enter your name doctor</label>
              <input
                type="text"
                value={inputNickname}
                onChange={(e) => setInputNickname(e.target.value)}
                className="w-full px-4 py-3 rounded-2xl border border-blue-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none transition-all"
                placeholder="Enter your name..."
                required
              />
            </div>

            <button
              type="submit"
              className="w-full bg-gradient-to-r from-blue-500 to-green-500 text-white py-3 rounded-2xl font-medium hover:from-blue-600 hover:to-green-600 transform hover:scale-105 transition-all duration-200 shadow-lg hover:shadow-xl"
            >
              Start Study Session 📚
            </button>
          </form>
        </div>
      </div>
    );
  }

  // 🧩 Chat Pages
  if (currentPage === 'chat1') {
    return <Chat1 nickname={nickname} onLogout={handleLogout} />;
  }

  if (currentPage === 'chat2') {
    return (
      <Chat2
        nickname={nickname as 'Vishwa' | 'Ammu'}
        onLogout={handleLogout}
        onSwitchToAIChat={handleSwitchToAIChat}
        onSwitchToChat3={handleSwitchToChat3}
      />
    );
  }

  if (currentPage === 'chat3') {
    return (
      <Chat3
        nickname={nickname as 'Vishwa' | 'Ammu'}
        onLogout={handleLogout}
        onSwitchToAIChat={handleSwitchToAIChat}
        onSwitchToChat2={handleSwitchToChat2}
        onOpenMemory={handleOpenMemory}
      />
    );
  }

  if (currentPage === 'memory') {
    return (
      <MemoryPage
        nickname={nickname as 'Vishwa' | 'Ammu'}
        onClose={handleLogout}
        onNavigateToChat1={() => setCurrentPage('chat1')}
        onNavigateToChat2={() => setCurrentPage('chat2')}
        onNavigateToChat3={() => setCurrentPage('chat3')}
      />
    );
  }

  return null;
}

// Wrap the entire app in an error boundary to prevent white screen crashes
function AppWithErrorBoundary() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}

export default AppWithErrorBoundary;
