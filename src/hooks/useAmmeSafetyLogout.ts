import { useEffect, useRef } from 'react';

interface UseAmmeSafetyLogoutProps {
  nickname: string | undefined;
  onLogout: () => void;
  isEnabled?: boolean;
}

export function useAmmeSafetyLogout({ nickname, onLogout, isEnabled = true }: UseAmmeSafetyLogoutProps) {
  const logoutTriggeredRef = useRef(false);

  // ⛔ NEW — this flag prevents logout when opening Camera/Gallery/Video/File
  const skipLogoutRef = useRef(false);

  // Expose methods globally so components can skip logout during their operation
  (window as any).__AMMU_SKIP_LOGOUT__ = {
    start: () => { skipLogoutRef.current = true; },
    stop: () => { skipLogoutRef.current = false; },
    get active() { return skipLogoutRef.current; }
  };

  useEffect(() => {
    if (!isEnabled || nickname !== 'Ammu') return;

    const safeLogout = (reason: string) => {
      if (logoutTriggeredRef.current) return;
      if (skipLogoutRef.current) return;  // 🚫 DO NOT LOGOUT while media window opens

      logoutTriggeredRef.current = true;
      console.warn(`🔐 Ammu safety logout: ${reason}`);
      onLogout();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        safeLogout('visibilitychange');
      }
    };

    const handlePageHide = () => {
      safeLogout('pagehide');
    };

    const handleWindowBlur = () => {
      setTimeout(() => {
        if (document.hidden) {
          safeLogout('blur');
        }
      }, 100);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [nickname, onLogout, isEnabled]);
}
