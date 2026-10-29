import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame } from "remotion";
import type { SceneProps, VideoProps } from "./types";

export const FONT = "Inter, -apple-system, Segoe UI, Helvetica, Arial, sans-serif";

/** Vendor logo and, for a personalized video, the prospect's logo beside it. */
export const LogoRow: React.FC<{ video: VideoProps; size: number; progress: number }> = ({ video, size, progress }) => {
  const vendor = video.brand.logo;
  const prospect = video.audience?.logo;
  if (!vendor && !prospect) return null;
  const box = (src: string | undefined, label: string, delay: number) => {
    const o = interpolate(progress, [delay, delay + 0.35], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return (
      <div style={{ display: "flex", alignItems: "center", gap: Math.round(size * 0.3), opacity: o }}>
        {src ? (
          <Img src={src} style={{ height: size, maxWidth: size * 3.2, objectFit: "contain", borderRadius: Math.round(size * 0.15), background: "rgba(255,255,255,0.06)", padding: Math.round(size * 0.12) }} />
        ) : (
          <div style={{ height: size, padding: `0 ${Math.round(size * 0.3)}px`, display: "flex", alignItems: "center", color: "#fff", fontFamily: FONT, fontWeight: 700, fontSize: Math.round(size * 0.46), background: "rgba(255,255,255,0.08)", borderRadius: Math.round(size * 0.15) }}>
            {label}
          </div>
        )}
      </div>
    );
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: Math.round(size * 0.45), marginBottom: Math.round(size * 0.6) }}>
      {box(vendor, video.brand.title ?? video.title, 0)}
      {video.audience && <div style={{ color: "rgba(255,255,255,0.45)", fontFamily: FONT, fontSize: Math.round(size * 0.5), opacity: interpolate(progress, [0.3, 0.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>×</div>}
      {video.audience && box(prospect, video.audience.company, 0.4)}
    </div>
  );
};

export const TitleScene: React.FC<{ scene: SceneProps; video: VideoProps }> = ({ scene, video }) => {
  const frame = useCurrentFrame();
  const N = scene.frames;
  const o = interpolate(frame, [0, 12, N - 10, N - 1], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(frame, [0, 14], [18, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const bar = interpolate(frame, [4, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const logos = interpolate(frame, [0, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const madeFor = video.audience ? interpolate(frame, [16, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;
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
        <LogoRow video={video} size={Math.round(video.height / 14)} progress={logos} />
        <div style={{ width: 96 * bar, height: 6, background: video.brand.accent, borderRadius: 3, marginBottom: 28 }} />
        <div style={{ color: "#fff", fontFamily: FONT, fontSize: Math.round(video.height / 11), fontWeight: 700, letterSpacing: -1, lineHeight: 1.05 }}>
          {scene.text}
        </div>
        {video.subtitle && (
          <div style={{ color: "rgba(255,255,255,0.72)", fontFamily: FONT, fontSize: Math.round(video.height / 26), marginTop: 18, maxWidth: video.width * 0.6 }}>
            {video.subtitle}
          </div>
        )}
        {video.audience && (
          <div style={{ marginTop: 34, opacity: madeFor, display: "inline-flex", alignItems: "center", gap: 12, color: "#fff", fontFamily: FONT, fontSize: Math.round(video.height / 30), padding: "10px 18px", borderRadius: 999, background: `${video.brand.accent}33`, border: `1px solid ${video.brand.accent}88` }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: video.brand.accent }} />
            Made for {video.audience.company}
            {video.audience.contact?.first ? ` · ${video.audience.contact.first}` : ""}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
