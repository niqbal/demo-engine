import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import type { SceneProps, VideoProps } from "./types";

export const TitleScene: React.FC<{ scene: SceneProps; video: VideoProps }> = ({ scene, video }) => {
  const frame = useCurrentFrame();
  const N = scene.frames;
  const o = interpolate(frame, [0, 12, N - 10, N - 1], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(frame, [0, 14], [18, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const bar = interpolate(frame, [4, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const font = "Inter, -apple-system, Segoe UI, Helvetica, Arial, sans-serif";
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1200px 700px at 30% 20%, ${video.brand.accent}22, transparent), ${video.brand.background}`,
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "0 10%",
        opacity: o
      }}
    >
      <div style={{ transform: `translateY(${y}px)` }}>
        <div style={{ width: 96 * bar, height: 6, background: video.brand.accent, borderRadius: 3, marginBottom: 28 }} />
        <div style={{ color: "#fff", fontFamily: font, fontSize: Math.round(video.height / 11), fontWeight: 700, letterSpacing: -1, lineHeight: 1.05 }}>
          {scene.text}
        </div>
        {video.subtitle && (
          <div style={{ color: "rgba(255,255,255,0.72)", fontFamily: font, fontSize: Math.round(video.height / 26), marginTop: 18, maxWidth: video.width * 0.6 }}>
            {video.subtitle}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
