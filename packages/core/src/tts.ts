import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export interface TTS {
  name: string;
  /** Returns a 16-bit PCM WAV buffer. */
  synthesize(text: string, voice?: string): Promise<Buffer>;
  /** Optional batch path for providers with expensive startup (one process, many lines). */
  synthesizeMany?(texts: string[], voice?: string): Promise<Buffer[]>;
}

export type TTSPreference = "auto" | "openai" | "elevenlabs" | "kokoro" | "say" | "silent";

export function createTTS(pref: TTSPreference = "auto"): TTS {
  const hasEleven = !!process.env.ELEVENLABS_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const isMac = process.platform === "darwin";
  const pick =
    pref === "auto"
      ? hasEleven ? "elevenlabs" : hasOpenAI ? "openai" : kokoroPython() ? "kokoro" : isMac ? "say" : "silent"
      : pref;
  switch (pick) {
    case "elevenlabs":
      return elevenLabs();
    case "openai":
      return openAI();
    case "kokoro":
      return kokoro();
    case "say":
      return macSay();
    default:
      return silent();
  }
}

function silent(): TTS {
  return {
    name: "silent",
    async synthesize(text) {
      const words = text.trim().split(/\s+/).length;
      const seconds = Math.max(1.5, words / 2.6);
      return pcmToWav(Buffer.alloc(Math.round(seconds * 22050) * 2), 22050, 1);
    }
  };
}

function openAI(): TTS {
  const model = process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
  return {
    name: `openai:${model}`,
    async synthesize(text, voice) {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI();
      const res = await client.audio.speech.create({
        model,
        voice: (voice ?? process.env.OPENAI_TTS_VOICE ?? "alloy") as "alloy",
        input: text,
        response_format: "wav"
      });
      return Buffer.from(await res.arrayBuffer());
    }
  };
}

function elevenLabs(): TTS {
  return {
    name: "elevenlabs",
    async synthesize(text, voice) {
      const voiceId = voice ?? process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_22050`, {
        method: "POST",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2" })
      });
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return pcmToWav(Buffer.from(await res.arrayBuffer()), 22050, 1);
    }
  };
}

/** Python interpreter that has the `kokoro` package, if any. */
export function kokoroPython(): string | undefined {
  const explicit = process.env.DEMO_ENGINE_KOKORO_PYTHON;
  const candidates = explicit ? [explicit] : ["python3", "python"];
  for (const py of candidates) {
    const r = spawnSync(py, ["-c", "import kokoro, soundfile"], { stdio: "ignore" });
    if (r.status === 0) return py;
  }
  return undefined;
}

const KOKORO_SCRIPT = `
import sys, json, warnings, os, platform
warnings.filterwarnings("ignore")
# The espeak-ng wheel bundled with misaki carries a build-time data path that is wrong on some
# platforms (notably Intel macOS). Prefer an explicit or Homebrew espeak-ng when present.
lib = os.environ.get("ESPEAK_NG_LIBRARY")
data = os.environ.get("ESPEAK_DATA_PATH")
if platform.system() == "Darwin" and not lib:
    for prefix in ("/opt/homebrew", "/usr/local"):
        if os.path.exists(prefix + "/lib/libespeak-ng.dylib") and os.path.exists(prefix + "/share/espeak-ng-data/phontab"):
            lib, data = prefix + "/lib/libespeak-ng.dylib", data or prefix + "/share/espeak-ng-data"
            break
if lib or data:
    try:
        import espeakng_loader
        if lib: espeakng_loader.get_library_path = lambda: lib
        if data: espeakng_loader.get_data_path = lambda: data
    except Exception:
        pass
import numpy as np, soundfile as sf
from kokoro import KPipeline
req = json.load(sys.stdin)
p = KPipeline(lang_code=req.get("lang", "a"), repo_id="hexgrad/Kokoro-82M")
for item in req["items"]:
    chunks = [a for _, _, a in p(item["text"], voice=req.get("voice") or "af_heart", speed=req.get("speed", 1.0))]
    audio = np.concatenate(chunks) if chunks else np.zeros(2400, dtype=np.float32)
    sf.write(item["out"], audio, 24000, subtype="PCM_16")
print("ok")
`;

/**
 * Kokoro-82M: open-weights neural TTS that runs locally (Apache-2.0).
 * Needs: pip install kokoro soundfile   (first run downloads ~330MB of weights)
 * Intel macOS also needs: brew install espeak-ng  (torch 2.2 + a broken bundled espeak path)
 */
function kokoro(): TTS {
  async function run(texts: string[], voice?: string): Promise<Buffer[]> {
    const py = kokoroPython();
    if (!py) throw new Error("kokoro not installed: pip install kokoro soundfile (or set DEMO_ENGINE_KOKORO_PYTHON)");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "demo-engine-"));
    const items = texts.map((text, i) => ({ text, out: path.join(dir, `${i}.wav`) }));
    await new Promise<void>((resolve, reject) => {
      const p = spawn(py, ["-c", KOKORO_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`kokoro exited ${c}: ${err.split("\n").filter((l) => l.trim()).slice(-3).join(" | ")}`))));
      p.on("error", reject);
      p.stdin.end(JSON.stringify({ items, voice: voice ?? process.env.KOKORO_VOICE ?? "af_heart", speed: Number(process.env.KOKORO_SPEED ?? 1.0) }));
    });
    const bufs = await Promise.all(items.map((it) => fs.readFile(it.out)));
    await fs.rm(dir, { recursive: true, force: true });
    return bufs;
  }
  return {
    name: "kokoro",
    synthesize: async (text, voice) => (await run([text], voice))[0],
    synthesizeMany: run
  };
}

function macSay(): TTS {
  return {
    name: "say",
    async synthesize(text, voice) {
      const tmp = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "demo-engine-")), "out.wav");
      const args = ["-o", tmp, "--file-format=WAVE", "--data-format=LEI16@22050"];
      if (voice) args.push("-v", voice);
      args.push(text);
      await new Promise<void>((resolve, reject) => {
        const p = spawn("say", args, { stdio: "ignore" });
        p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`say exited ${c}`))));
        p.on("error", reject);
      });
      const buf = await fs.readFile(tmp);
      await fs.rm(path.dirname(tmp), { recursive: true, force: true });
      return buf;
    }
  };
}

export function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bits = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Duration of a PCM WAV buffer in milliseconds (walks RIFF chunks). */
export function wavDurationMs(buf: Buffer): number {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a WAV file");
  let off = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      dataLen = Math.min(size, buf.length - off - 8);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!sampleRate) throw new Error("WAV has no fmt chunk");
  const bytesPerSec = (sampleRate * channels * bits) / 8;
  return Math.round((dataLen / bytesPerSec) * 1000);
}
