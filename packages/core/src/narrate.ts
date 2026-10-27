import { promises as fs } from "node:fs";
import path from "node:path";
import type { LLM } from "./llm.js";
import { parseJsonLoose } from "./llm.js";
import type { RunResult } from "./runner.js";
import type { Flow } from "./schema.js";
import type { Store } from "./store.js";
import type { TTS } from "./tts.js";
import { wavDurationMs } from "./tts.js";
import { ensureDir, exists, readJson, sha256, silentLogger, writeJson, type Logger } from "./util.js";

export interface NarrationStep {
  index: number;
  say: string;
  text: string;
  audio: string; // absolute path to wav
  durationMs: number;
  cached: boolean;
}

export interface Narration {
  version: 1;
  llm: string;
  tts: string;
  voice?: string;
  steps: NarrationStep[];
}

export interface NarrateOptions {
  store: Store;
  tts: TTS;
  /** Used when `tts` throws (e.g. no credits). */
  fallbackTTS?: TTS;
  llm?: LLM | null;
  voice?: string;
  glossary?: string;
  logger?: Logger;
  /** Skip LLM polishing and read `say` verbatim. */
  verbatim?: boolean;
}

const SYSTEM = `You write voice-over for short product walkthrough videos.
Rewrite each step's note into one or two natural spoken sentences (max 30 words per step).
Keep product terms exactly as given in the glossary. Keep the order. Do not add steps, greetings or sign-offs.
Return JSON: {"lines": ["...", "..."]} with exactly one string per input step.`;

export async function polishScript(llm: LLM, flow: Flow, says: string[], glossary?: string): Promise<string[]> {
  const user = [
    `Product walkthrough: ${flow.name}${flow.description ? ` — ${flow.description}` : ""}`,
    glossary ? `Glossary:\n${glossary}` : "",
    `Steps:\n${says.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
  ]
    .filter(Boolean)
    .join("\n\n");
  const raw = await llm.complete({ system: SYSTEM, user, json: true, maxTokens: 1500 });
  const parsed = parseJsonLoose<{ lines?: unknown }>(raw);
  const lines = Array.isArray(parsed.lines) ? parsed.lines.map((l) => String(l).trim()) : [];
  if (lines.length !== says.length) throw new Error(`narration: expected ${says.length} lines, got ${lines.length}`);
  return lines.map((l, i) => l || says[i]);
}

export async function narrateRun(flow: Flow, run: RunResult, opts: NarrateOptions): Promise<Narration> {
  const log = opts.logger ?? silentLogger;
  const says = run.steps.map((s) => s.say);
  const llmName = opts.llm && !opts.verbatim ? opts.llm.name : "verbatim";

  // Script (one LLM call per flow, cached by inputs).
  let lines = says;
  if (opts.llm && !opts.verbatim) {
    const scriptDir = path.join(opts.store.out, "cache", "script");
    await ensureDir(scriptDir);
    const key = sha256(JSON.stringify({ llm: opts.llm.name, says, glossary: opts.glossary ?? "", name: flow.name })).slice(0, 24);
    const cachePath = path.join(scriptDir, `${key}.json`);
    if (await exists(cachePath)) {
      lines = (await readJson<{ lines: string[] }>(cachePath)).lines;
      log.debug("script: cache hit");
    } else {
      log.info(`script: polishing ${says.length} lines with ${opts.llm.name}`);
      try {
        lines = await polishScript(opts.llm, flow, says, opts.glossary);
        await writeJson(cachePath, { lines });
      } catch (e) {
        log.warn(`script: ${(e as Error).message}; using notes verbatim`);
        lines = says;
      }
    }
  }

  // Audio (one TTS call per changed line, cached by text+voice+provider).
  const audioDir = opts.store.audioCacheDir();
  await ensureDir(audioDir);
  const steps: NarrationStep[] = [];
  let tts = opts.tts;
  for (let i = 0; i < run.steps.length; i++) {
    const text = lines[i];
    const key = sha256(JSON.stringify({ tts: tts.name, voice: opts.voice ?? "", text })).slice(0, 24);
    const wav = path.join(audioDir, `${key}.wav`);
    const meta = path.join(audioDir, `${key}.json`);
    let durationMs: number;
    let cached = true;
    if ((await exists(wav)) && (await exists(meta))) {
      durationMs = (await readJson<{ durationMs: number }>(meta)).durationMs;
    } else {
      cached = false;
      log.info(`tts: step ${i + 1} (${tts.name})`);
      let buf: Buffer;
      try {
        buf = await tts.synthesize(text, opts.voice);
      } catch (e) {
        if (!opts.fallbackTTS || tts === opts.fallbackTTS) throw e;
        log.warn(`tts: ${tts.name} failed (${(e as Error).message.split("\n")[0]}); falling back to ${opts.fallbackTTS.name}`);
        tts = opts.fallbackTTS;
        buf = await tts.synthesize(text, opts.voice);
      }
      durationMs = wavDurationMs(buf);
      await fs.writeFile(wav, buf);
      await writeJson(meta, { durationMs, text, voice: opts.voice ?? null, tts: opts.tts.name });
    }
    steps.push({ index: i, say: says[i], text, audio: path.resolve(wav), durationMs, cached });
  }
  const narration: Narration = { version: 1, llm: llmName, tts: tts.name, voice: opts.voice, steps };
  await writeJson(path.join(run.runDir, "narration.json"), narration);
  return narration;
}
