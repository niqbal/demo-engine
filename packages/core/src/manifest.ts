import path from "node:path";
import type { Narration } from "./narrate.js";
import type { Rect, RunResult } from "./runner.js";
import type { Config, Flow } from "./schema.js";
import type { Audience } from "./audience.js";
import { writeJson } from "./util.js";

export interface Scene {
  index: number;
  kind: "title" | "step" | "end";
  text: string;
  audio?: string;
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

/** Who the video is for. Rendered on the title card ("Made for Acme") and the end card (the rep). */
export interface ManifestAudience {
  id: string;
  company: string;
  logo?: string;
  industry?: string;
  contact?: { first?: string; last?: string; title?: string };
  rep?: { name?: string; title?: string; email?: string; calendar?: string; photo?: string };
}

export interface Manifest {
  version: 1;
  title: string;
  subtitle?: string;
  fps: number;
  width: number;
  height: number;
  scale: number;
  captions: boolean;
  brand: { accent: string; background: string; logo?: string; title?: string };
  audience?: ManifestAudience;
  end?: { text: string; url?: string };
  scenes: Scene[];
  totalFrames: number;
  totalDurationMs: number;
}

export interface ManifestOptions {
  fps?: number;
  captions?: boolean;
  brand?: Config["brand"];
  title?: boolean;
  minSceneMs?: number;
  tailMs?: number;
  audience?: Audience;
}

export function buildManifest(flow: Flow, run: RunResult, narration: Narration, opts: ManifestOptions = {}): Manifest {
  const fps = opts.fps ?? 30;
  const minSceneMs = opts.minSceneMs ?? 2600;
  const tailMs = opts.tailMs ?? 700;
  const toFrames = (ms: number) => Math.max(1, Math.round((ms / 1000) * fps));
  const audience = opts.audience && opts.audience.id !== "default" ? opts.audience : undefined;
  const scenes: Scene[] = [];
  if (opts.title !== false) {
    const ms = audience ? 2400 : 1800;
    scenes.push({ index: -1, kind: "title", text: flow.name, durationMs: ms, frames: toFrames(ms), actionKind: "none" });
  }
  for (const s of run.steps) {
    const n = narration.steps[s.index];
    const typingMs = s.typing?.length ? 500 + s.typing.length * 110 : 0;
    const ms = Math.max(minSceneMs, (n?.durationMs ?? 0) + tailMs, typingMs + 1500);
    scenes.push({
      index: s.index,
      kind: "step",
      text: n?.text ?? s.say,
      audio: n?.audio,
      durationMs: ms,
      frames: toFrames(ms),
      before: path.resolve(run.runDir, s.before),
      after: path.resolve(run.runDir, s.after),
      hover: s.hover ? path.resolve(run.runDir, s.hover) : undefined,
      typing: s.typing?.map((t) => path.resolve(run.runDir, t)),
      targetRect: s.targetRect,
      zoomRect: s.zoomRect,
      zoomScale: s.zoomScale,
      actionKind: s.action.kind
    });
  }
  // End card when the flow asks for one, the brand has a call to action, or the audience names a rep.
  const endText = flow.end?.text ?? opts.brand?.cta ?? (audience?.rep?.name ? `Questions? Talk to ${audience.rep.name}.` : undefined);
  let end: Manifest["end"] | undefined;
  if (endText !== undefined || flow.end || audience?.rep) {
    end = { text: endText ?? "Thanks for watching.", url: audience?.rep?.calendar ?? flow.end?.url ?? opts.brand?.url };
    const ms = 3200;
    scenes.push({ index: run.steps.length, kind: "end", text: end.text, durationMs: ms, frames: toFrames(ms), actionKind: "none" });
  }
  const totalFrames = scenes.reduce((a, s) => a + s.frames, 0);
  return {
    version: 1,
    title: flow.name,
    subtitle: flow.description,
    fps,
    width: run.viewport.width,
    height: run.viewport.height,
    scale: run.scale,
    captions: opts.captions ?? true,
    brand: {
      accent: audience?.accent ?? opts.brand?.accent ?? "#4F46E5",
      background: opts.brand?.background ?? "#0B0F19",
      logo: opts.brand?.logo,
      title: opts.brand?.title
    },
    audience: audience
      ? {
          id: audience.id,
          company: audience.company,
          logo: audience.logo,
          industry: audience.industry,
          contact: audience.contact,
          rep: audience.rep
        }
      : undefined,
    end,
    scenes,
    totalFrames,
    totalDurationMs: scenes.reduce((a, s) => a + s.durationMs, 0)
  };
}

export async function writeManifest(manifest: Manifest, file: string): Promise<void> {
  await writeJson(file, manifest);
}
