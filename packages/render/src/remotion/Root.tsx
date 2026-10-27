import React from "react";
import { Composition } from "remotion";
import { DemoVideo } from "./DemoVideo";
import type { VideoProps } from "./types";

const defaultProps: VideoProps = {
  title: "Demo",
  fps: 30,
  width: 1440,
  height: 900,
  scale: 2,
  captions: true,
  brand: { accent: "#4F46E5", background: "#0B0F19" },
  scenes: [{ index: -1, kind: "title", text: "Demo", durationMs: 1500, frames: 45, actionKind: "none" }],
  totalFrames: 45
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Demo"
    component={DemoVideo}
    durationInFrames={defaultProps.totalFrames}
    fps={defaultProps.fps}
    width={defaultProps.width}
    height={defaultProps.height}
    defaultProps={defaultProps}
    calculateMetadata={({ props }: { props: VideoProps }) => ({
      durationInFrames: Math.max(1, props.totalFrames),
      fps: props.fps,
      width: props.width,
      height: props.height
    })}
  />
);
