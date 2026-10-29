import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { EndScene } from "./EndScene";
import { StepScene } from "./StepScene";
import { TitleScene } from "./TitleScene";
import type { VideoProps } from "./types";

export const DemoVideo: React.FC<VideoProps> = (video) => {
  let from = 0;
  let cursor = { x: video.width * 0.55, y: video.height * 0.6 };
  const items: React.ReactNode[] = [];
  for (const scene of video.scenes) {
    const start = from;
    const cursorFrom = cursor;
    items.push(
      <Sequence key={`${scene.kind}-${scene.index}`} from={start} durationInFrames={scene.frames} name={scene.text.slice(0, 40)}>
        {scene.kind === "title" ? (
          <TitleScene scene={scene} video={video} />
        ) : scene.kind === "end" ? (
          <EndScene scene={scene} video={video} />
        ) : (
          <StepScene scene={scene} video={video} cursorFrom={cursorFrom} />
        )}
      </Sequence>
    );
    if (scene.targetRect) cursor = { x: scene.targetRect.x + scene.targetRect.width / 2, y: scene.targetRect.y + scene.targetRect.height / 2 };
    from += scene.frames;
  }
  return <AbsoluteFill style={{ background: video.brand.background }}>{items}</AbsoluteFill>;
};
