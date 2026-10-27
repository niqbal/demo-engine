import React from "react";
import { AbsoluteFill, Audio, Easing, Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Cursor } from "./Cursor";
import type { Rect, SceneProps, VideoProps } from "./types";

export interface StepSceneProps {
  scene: SceneProps;
  video: VideoProps;
  cursorFrom: { x: number; y: number };
}

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export const StepScene: React.FC<StepSceneProps> = ({ scene, video, cursorFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const N = scene.frames;
  const hasTarget = !!scene.targetRect;
  const target = scene.targetRect ? center(scene.targetRect) : cursorFrom;
  const moveFrames = hasTarget ? Math.min(Math.round(0.9 * fps), Math.max(8, Math.round(N * 0.3))) : 0;
  const clickAt = moveFrames;
  const typing = scene.typing ?? [];
  const typingFrames = typing.length ? Math.round(fps * (0.5 + typing.length * 0.11)) : 0;
  const swapStart = clickAt + 3 + typingFrames;
  const swapEnd = swapStart + 2; // hard cut: screen recordings do not cross-fade
  // Hover state shows once the cursor arrives, before the click.
  const hoverO = scene.hover ? interpolate(frame, [moveFrames - 6, moveFrames - 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;
  const typingIndex = typing.length ? Math.min(typing.length - 1, Math.floor(interpolate(frame, [clickAt + 2, clickAt + 2 + typingFrames], [0, typing.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }))) : -1;
  const typingVisible = typing.length > 0 && frame >= clickAt + 2;

  const ease = Easing.inOut(Easing.cubic);
  const cx = interpolate(frame, [0, moveFrames], [cursorFrom.x, target.x], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const cy = interpolate(frame, [0, moveFrames], [cursorFrom.y, target.y], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const pressed = hasTarget ? interpolate(frame, [clickAt, clickAt + 3, clickAt + 8], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;
  const afterOpacity = interpolate(frame, [swapStart, swapEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Click ripple.
  const rippleT = hasTarget ? interpolate(frame, [clickAt, clickAt + Math.round(fps * 0.45)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const rippleR = 10 + rippleT * 34;
  const rippleO = hasTarget && frame >= clickAt ? (1 - rippleT) * 0.6 : 0;

  // Zoom.
  let zoom = 1;
  let origin = "50% 50%";
  if (scene.zoomRect && scene.zoomScale && scene.zoomScale > 1) {
    const zc = center(scene.zoomRect);
    const zIn0 = clickAt + 4;
    const zIn1 = zIn0 + Math.round(fps * 0.5);
    const zOut1 = N - 1;
    const zOut0 = Math.max(zIn1 + 1, N - Math.round(fps * 0.45));
    zoom = interpolate(frame, [zIn0, zIn1, zOut0, zOut1], [1, scene.zoomScale, scene.zoomScale, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
    origin = `${(zc.x / video.width) * 100}% ${(zc.y / video.height) * 100}%`;
  }

  const captionO = interpolate(frame, [0, 8, N - 8, N - 1], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: video.brand.background }}>
      <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: origin }}>
        {scene.before && <Img src={scene.before} style={{ width: video.width, height: video.height, position: "absolute" }} />}
        {scene.hover && hoverO > 0 && (
          <Img src={scene.hover} style={{ width: video.width, height: video.height, position: "absolute", opacity: hoverO }} />
        )}
        {typingVisible && (
          <Img src={typing[typingIndex]} style={{ width: video.width, height: video.height, position: "absolute" }} />
        )}
        {scene.after && (
          <Img src={scene.after} style={{ width: video.width, height: video.height, position: "absolute", opacity: afterOpacity }} />
        )}
        {hasTarget && rippleO > 0 && (
          <div
            style={{
              position: "absolute",
              left: target.x - rippleR,
              top: target.y - rippleR,
              width: rippleR * 2,
              height: rippleR * 2,
              borderRadius: "50%",
              border: `3px solid ${video.brand.accent}`,
              opacity: rippleO,
              pointerEvents: "none"
            }}
          />
        )}
        <Cursor x={cx} y={cy} pressed={pressed} />
      </AbsoluteFill>
      {video.captions && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 36,
            display: "flex",
            justifyContent: "center",
            opacity: captionO,
            pointerEvents: "none"
          }}
        >
          <div
            style={{
              maxWidth: video.width * 0.78,
              background: "rgba(10,12,20,0.82)",
              color: "#fff",
              fontFamily: "Inter, -apple-system, Segoe UI, Helvetica, Arial, sans-serif",
              fontSize: Math.round(video.height / 34),
              lineHeight: 1.35,
              padding: "12px 22px",
              borderRadius: 14,
              borderLeft: `5px solid ${video.brand.accent}`,
              boxShadow: "0 8px 30px rgba(0,0,0,0.35)"
            }}
          >
            {scene.text}
          </div>
        </div>
      )}
      {scene.audio && <Audio src={scene.audio} />}
    </AbsoluteFill>
  );
};
