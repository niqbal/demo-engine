import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { Manifest } from "@demo-engine/core";
import type { VideoProps } from "./remotion/types.js";

export interface RenderOptions {
  outFile: string;
  /** Directory where the Remotion webpack bundle is cached. */
  bundleDir: string;
  rebundle?: boolean;
  concurrency?: number;
  poster?: string;
  log?: (msg: string) => void;
  onProgress?: (pct: number) => void;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, "..", "src", "remotion", "index.tsx");

async function dataUrl(file: string, mime: string): Promise<string> {
  const buf = await fs.readFile(file);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Inline every screenshot and audio file so the bundle needs no public dir. */
export async function manifestToProps(m: Manifest): Promise<VideoProps> {
  const scenes = [];
  for (const s of m.scenes) {
    scenes.push({
      index: s.index,
      kind: s.kind,
      text: s.text,
      durationMs: s.durationMs,
      frames: s.frames,
      actionKind: s.actionKind,
      targetRect: s.targetRect,
      zoomRect: s.zoomRect,
      zoomScale: s.zoomScale,
      before: s.before ? await dataUrl(s.before, "image/png") : undefined,
      after: s.after ? await dataUrl(s.after, "image/png") : undefined,
      hover: s.hover ? await dataUrl(s.hover, "image/png") : undefined,
      typing: s.typing ? await Promise.all(s.typing.map((t) => dataUrl(t, "image/png"))) : undefined,
      audio: s.audio ? await dataUrl(s.audio, "audio/wav") : undefined
    });
  }
  return {
    title: m.title,
    subtitle: m.subtitle,
    fps: m.fps,
    width: m.width,
    height: m.height,
    scale: m.scale,
    captions: m.captions,
    brand: m.brand,
    scenes,
    totalFrames: m.totalFrames
  };
}

export async function ensureBundle(bundleDirIn: string, rebundle = false, log?: (m: string) => void): Promise<string> {
  const bundleDir = path.resolve(bundleDirIn);
  const marker = path.join(bundleDir, "index.html");
  const stamp = path.join(bundleDir, ".demo-engine-entry");
  let fresh = false;
  try {
    await fs.access(marker);
    fresh = (await fs.readFile(stamp, "utf8")) === ENTRY + "\n" + (await fs.stat(ENTRY)).mtimeMs;
  } catch {
    fresh = false;
  }
  if (fresh && !rebundle) return bundleDir;
  log?.("bundling Remotion composition (first run only)");
  await fs.rm(bundleDir, { recursive: true, force: true });
  const out = await bundle({ entryPoint: ENTRY, outDir: bundleDir });
  await fs.writeFile(stamp, ENTRY + "\n" + (await fs.stat(ENTRY)).mtimeMs, "utf8");
  return out;
}

export async function renderVideo(manifest: Manifest, opts: RenderOptions): Promise<{ outFile: string; poster?: string }> {
  const serveUrl = await ensureBundle(opts.bundleDir, opts.rebundle, opts.log);
  const inputProps = (await manifestToProps(manifest)) as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: "Demo", inputProps });
  const outFile = path.resolve(opts.outFile);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  let last = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outFile,
    inputProps,
    concurrency: opts.concurrency ?? null,
    onProgress: ({ progress }) => {
      const pct = Math.floor(progress * 100);
      if (pct !== last && pct % 10 === 0) {
        last = pct;
        opts.onProgress?.(pct);
      }
    }
  });
  let poster: string | undefined;
  if (opts.poster) {
    const firstStep = manifest.scenes.find((s) => s.kind === "step");
    const frame = firstStep ? manifest.scenes.slice(0, manifest.scenes.indexOf(firstStep)).reduce((a, s) => a + s.frames, 0) + Math.min(firstStep.frames - 1, Math.round(manifest.fps * 1.2)) : 0;
    poster = path.resolve(opts.poster);
    await renderStill({ composition, serveUrl, output: poster, inputProps, frame });
  }
  return { outFile, poster };
}
