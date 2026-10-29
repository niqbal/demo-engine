export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneProps {
  index: number;
  kind: "title" | "step" | "end";
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

export interface AudienceProps {
  id: string;
  company: string;
  logo?: string; // data url
  industry?: string;
  contact?: { first?: string; last?: string; title?: string };
  rep?: { name?: string; title?: string; email?: string; calendar?: string; photo?: string };
}

export interface VideoProps {
  title: string;
  subtitle?: string;
  fps: number;
  width: number;
  height: number;
  scale: number;
  captions: boolean;
  brand: { accent: string; background: string; logo?: string; title?: string };
  audience?: AudienceProps;
  end?: { text: string; url?: string };
  scenes: SceneProps[];
  totalFrames: number;
}
