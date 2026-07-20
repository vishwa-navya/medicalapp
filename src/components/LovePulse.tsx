import React from 'react';

interface LovePulseProps {
  active: boolean;
  children: React.ReactNode;
  color?: string;
  size?: number;
}

function LovePulse({ active, children, color = 'rgba(244,63,94,0.6)', size = 48 }: LovePulseProps) {
  if (!active) return <>{children}</>;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      {/* Expanding ripple rings */}
      <span
        className="absolute inset-0 rounded-full love-pulse-ring"
        style={{ borderColor: color, animationDelay: '0s' }}
      />
      <span
        className="absolute inset-0 rounded-full love-pulse-ring"
        style={{ borderColor: color, animationDelay: '0.6s' }}
      />
      <span
        className="absolute inset-0 rounded-full love-pulse-ring"
        style={{ borderColor: color, animationDelay: '1.2s' }}
      />
      {/* Glow halo */}
      <span
        className="absolute inset-0 rounded-full love-pulse-glow"
        style={{ boxShadow: `0 0 12px 3px ${color}` }}
      />
      {/* Content sits on top */}
      <div className="relative z-10">{children}</div>
    </div>
  );
}

export default LovePulse;
