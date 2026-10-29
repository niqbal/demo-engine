import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame } from "remotion";
import { FONT, LogoRow } from "./TitleScene";
import type { SceneProps, VideoProps } from "./types";

/** Closing card: call to action, the rep's card for a personalized video, and the link to book time. */
export const EndScene: React.FC<{ scene: SceneProps; video: VideoProps }> = ({ scene, video }) => {
  const frame = useCurrentFrame();
  const N = scene.frames;
  const o = interpolate(frame, [0, 10, N - 8, N - 1], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(frame, [0, 16], [20, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const card = interpolate(frame, [12, 28], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const rep = video.audience?.rep;
  const url = video.end?.url;
  const h = video.height;
  const initials = (rep?.name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1100px 650px at 70% 80%, ${video.brand.accent}26, transparent), ${video.brand.background}`,
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "0 10%",
        opacity: o
      }}
    >
      <div style={{ transform: `translateY(${y}px)`, width: "100%" }}>
        <LogoRow video={video} size={Math.round(h / 16)} progress={1} />
        <div style={{ color: "#fff", fontFamily: FONT, fontSize: Math.round(h / 13), fontWeight: 700, letterSpacing: -1, lineHeight: 1.08, maxWidth: video.width * 0.7 }}>
          {scene.text}
        </div>
        {(rep?.name || url) && (
          <div
            style={{
              marginTop: Math.round(h / 22),
              opacity: card,
              transform: `translateY(${(1 - card) * 14}px)`,
              display: "inline-flex",
              alignItems: "center",
              gap: Math.round(h / 40),
              padding: `${Math.round(h / 48)}px ${Math.round(h / 32)}px`,
              borderRadius: Math.round(h / 45),
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.12)"
            }}
          >
            {rep?.name &&
              (rep.photo ? (
                <Img src={rep.photo} style={{ width: Math.round(h / 9), height: Math.round(h / 9), borderRadius: "50%", objectFit: "cover" }} />
              ) : (
                <div style={{ width: Math.round(h / 9), height: Math.round(h / 9), borderRadius: "50%", background: video.brand.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, fontWeight: 700, fontSize: Math.round(h / 24) }}>
                  {initials}
                </div>
              ))}
            <div style={{ fontFamily: FONT }}>
              {rep?.name && <div style={{ color: "#fff", fontSize: Math.round(h / 24), fontWeight: 600 }}>{rep.name}</div>}
              {rep?.title && <div style={{ color: "rgba(255,255,255,0.7)", fontSize: Math.round(h / 34), marginTop: 2 }}>{rep.title}</div>}
              {(url || rep?.email) && (
                <div style={{ color: video.brand.accent, fontSize: Math.round(h / 32), marginTop: 8, fontWeight: 600 }}>
                  {url ? url.replace(/^https?:\/\//, "") : rep?.email}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
