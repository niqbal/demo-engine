import React from "react";

export const Cursor: React.FC<{ x: number; y: number; pressed?: number; size?: number }> = ({ x, y, pressed = 0, size = 26 }) => {
  const s = 1 - pressed * 0.12;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: size,
        height: size * 1.35,
        transform: `scale(${s})`,
        transformOrigin: "top left",
        filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.35))",
        pointerEvents: "none"
      }}
    >
      <svg viewBox="0 0 20 27" width={size} height={size * 1.35}>
        <path
          d="M1.5 1.5 L1.5 20.5 L6.2 16.2 L9.4 24.6 L13.2 23.1 L10 14.9 L16.5 14.9 Z"
          fill="#111"
          stroke="#fff"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};
