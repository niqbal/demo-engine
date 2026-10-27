export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneProps {
  index: number;
  kind: "title" | "step";
  text: string;
  audio?: string; // data url or static path
  durationMs: number;
  frames: number;
  before?: string;
  after?: string;
  hover?: string;
  typing?: string[];
  targetRect?: Rect;
  zoomRect?: Rect;
  zoomScale?: number;
  actionKind: string;
}

export interface VideoProps {
  title: string;
  subtitle?: string;
  fps: number;
  width: number;
  height: number;
  scale: number;
  captions: boolean;
  brand: { accent: string; background: string; logo?: string };
  scenes: SceneProps[];
  totalFrames: number;
}
