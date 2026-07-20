import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

export function useEmergencyExit(nickname: 'Vishwa' | 'Ammu') {
  const ignoreNextBlur = useRef(false);

  useEffect(() => {
    if (nickname !== 'Ammu') return;

    // Skip on any touch-capable device (phones, tablets, iPads in desktop mode)
    const isTouchDevice =
      /iPhone|iPad|Android|Mobile|Tablet/i.test(navigator.userAgent) ||
      navigator.maxTouchPoints > 0 ||
      ('ontouchstart' in window);
    if (isTouchDevice) return;

    const emergencyLogout = async () => {
      // Respect the global skip flag (set by ChatHistoryPage, Camera, Gallery, etc.)
      if ((window as any).__AMMU_SKIP_LOGOUT__?.active) {
        console.log('[EmergencyExit] Skip flag active — ignoring logout trigger');
        return;
      }
      await supabase.auth.signOut();
      window.location.replace('/login');
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        emergencyLogout();
      }
    };

    const handleBlur = () => {
      if (ignoreNextBlur.current) {
        ignoreNextBlur.current = false;
        return;
      }
      // Check skip flag before logout
      if ((window as any).__AMMU_SKIP_LOGOUT__?.active) {
        return;
      }
      emergencyLogout();
    };

    const handleFileOpen = () => {
      ignoreNextBlur.current = true;
      setTimeout(() => {
        ignoreNextBlur.current = false;
      }, 1500);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', () => (ignoreNextBlur.current = false));

    // Mark file picker usage
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' &&
        (target as HTMLInputElement).type === 'file'
      ) {
        handleFileOpen();
      }
    });

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleBlur);
    };
  }, [nickname]);
}
