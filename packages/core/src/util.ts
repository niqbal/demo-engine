import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(input: string | Buffer, len = 12): string {
  return sha256(input).slice(0, len);
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}

export async function writeJson(p: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "flow";
}

export function timestampId(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};

export function createLogger(verbose = false): Logger {
  const ts = () => new Date().toISOString().slice(11, 19);
  return {
    info: (m) => console.log(`[${ts()}] ${m}`),
    warn: (m) => console.warn(`[${ts()}] warn: ${m}`),
    error: (m) => console.error(`[${ts()}] error: ${m}`),
    debug: (m) => (verbose ? console.log(`[${ts()}] debug: ${m}`) : undefined)
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
