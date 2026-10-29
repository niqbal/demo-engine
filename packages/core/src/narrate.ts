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
import type { Audience } from "./audience.js";

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
  /** The prospect this narration is for. The script writer argues their case; the voice may follow their language. */
  audience?: Audience;
}

const SYSTEM = `You write voice-over for short product walkthrough videos.
Rewrite each step's note into one or two natural spoken sentences (max 30 words per step).
Keep product terms exactly as given in the glossary. Keep the order. Do not add steps, greetings or sign-offs.
When an audience is given, speak to that company: use their name where the note does, and connect the step to their situation when it is natural, never forced.
Return JSON: {"lines": ["...", "..."]} with exactly one string per input step.`;

export function audienceBrief(a?: Audience): string {
  if (!a || a.id === "default") return "";
  const parts = [`Company: ${a.company}`];
  if (a.industry) parts.push(`Industry: ${a.industry}`);
  if (a.contact?.first || a.contact?.title) parts.push(`Viewer: ${[a.contact.first, a.contact.last].filter(Boolean).join(" ")}${a.contact.title ? `, ${a.contact.title}` : ""}`);
  if (a.pitch) parts.push(`Context: ${a.pitch}`);
  return parts.join("\n");
}

export async function polishScript(llm: LLM, flow: Flow, says: string[], glossary?: string, audience?: Audience): Promise<string[]> {
  const brief = audienceBrief(audience);
  const user = [
    `Product walkthrough: ${flow.name}${flow.description ? ` — ${flow.description}` : ""}`,
    brief ? `Audience (who is watching):\n${brief}` : "",
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
    const key = sha256(JSON.stringify({ llm: opts.llm.name, says, glossary: opts.glossary ?? "", name: flow.name, audience: audienceBrief(opts.audience) })).slice(0, 24);
    const cachePath = path.join(scriptDir, `${key}.json`);
    if (await exists(cachePath)) {
      lines = (await readJson<{ lines: string[] }>(cachePath)).lines;
      log.debug("script: cache hit");
    } else {
      log.info(`script: polishing ${says.length} lines with ${opts.llm.name}${opts.audience && opts.audience.id !== "default" ? ` for ${opts.audience.company}` : ""}`);
      try {
        lines = await polishScript(opts.llm, flow, says, opts.glossary, opts.audience);
        await writeJson(cachePath, { lines });
      } catch (e) {
        log.warn(`script: ${(e as Error).message}; using notes verbatim`);
        lines = says;
      }
    }
  }

  // Audio: cached per text+voice+provider. Uncached lines go to the provider in one batch when it supports it.
  const audioDir = opts.store.audioCacheDir();
  await ensureDir(audioDir);
  let tts = opts.tts;
  const keyFor = (text: string) => sha256(JSON.stringify({ tts: tts.name, voice: opts.voice ?? "", text })).slice(0, 24);
  const pending: { index: number; text: string }[] = [];
  for (let i = 0; i < run.steps.length; i++) {
    const key = keyFor(lines[i]);
    if (!((await exists(path.join(audioDir, `${key}.wav`))) && (await exists(path.join(audioDir, `${key}.json`))))) pending.push({ index: i, text: lines[i] });
  }
  const synthesizeAll = async (provider: TTS): Promise<Buffer[]> => {
    if (provider.synthesizeMany && pending.length > 1) return provider.synthesizeMany(pending.map((p) => p.text), opts.voice);
    const out: Buffer[] = [];
    for (const p of pending) out.push(await provider.synthesize(p.text, opts.voice));
    return out;
  };
  if (pending.length) {
    const cachedN = run.steps.length - pending.length;
    log.info(`tts: ${pending.length} line${pending.length === 1 ? "" : "s"} with ${tts.name}${cachedN ? ` (${cachedN} cached)` : ""}`);
    let bufs: Buffer[];
    try {
      bufs = await synthesizeAll(tts);
    } catch (e) {
      if (!opts.fallbackTTS || tts === opts.fallbackTTS) throw e;
      log.warn(`tts: ${tts.name} failed (${(e as Error).message.split("\n")[0]}); falling back to ${opts.fallbackTTS.name}`);
      tts = opts.fallbackTTS;
      bufs = await synthesizeAll(tts);
    }
    for (let j = 0; j < pending.length; j++) {
      const key = keyFor(pending[j].text);
      await fs.writeFile(path.join(audioDir, `${key}.wav`), bufs[j]);
      await writeJson(path.join(audioDir, `${key}.json`), { durationMs: wavDurationMs(bufs[j]), text: pending[j].text, voice: opts.voice ?? null, tts: tts.name });
    }
  }
  const steps: NarrationStep[] = [];
  for (let i = 0; i < run.steps.length; i++) {
    const text = lines[i];
    const key = keyFor(text);
    const meta = await readJson<{ durationMs: number }>(path.join(audioDir, `${key}.json`));
    steps.push({ index: i, say: says[i], text, audio: path.resolve(path.join(audioDir, `${key}.wav`)), durationMs: meta.durationMs, cached: !pending.some((p) => p.index === i) });
  }
  const narration: Narration = { version: 1, llm: llmName, tts: tts.name, voice: opts.voice, steps };
  await writeJson(path.join(run.runDir, "narration.json"), narration);
  return narration;
}
