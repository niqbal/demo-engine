import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Flow, StepSpec } from "./schema.js";
import { exists, slugify } from "./util.js";

/**
 * An audience is one prospect or customer a demo is personalized for.
 *
 *   flow (template) × audience (data) = personalized run → personalized video
 *
 * Known fields are typed; anything else is allowed and reachable from flows as
 * `{{audience.<path>}}` (nested paths with dots, e.g. `{{audience.contact.first}}`).
 */
export const AudienceSchema = z
  .object({
    id: z.string().min(1).optional(),
    company: z.string().min(1),
    logo: z.string().optional(),
    industry: z.string().optional(),
    website: z.string().optional(),
    contact: z
      .object({ first: z.string().optional(), last: z.string().optional(), title: z.string().optional(), email: z.string().optional() })
      .partial()
      .optional(),
    /** The account executive presenting this demo; shown on the end card. */
    rep: z
      .object({ name: z.string().optional(), title: z.string().optional(), email: z.string().optional(), calendar: z.string().optional(), photo: z.string().optional() })
      .partial()
      .optional(),
    /** Free text: pain points, why they are evaluating. Given to the LLM when polishing narration. */
    pitch: z.string().optional(),
    voice: z.string().optional(),
    accent: z.string().optional(),
    language: z.string().optional()
  })
  .passthrough();

export type Audience = z.infer<typeof AudienceSchema> & { id: string };

export const DEFAULT_AUDIENCE_ID = "default";

export class AudienceError extends Error {}

function normalize(raw: unknown, file: string): Audience {
  const res = AudienceSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new AudienceError(`${file}: invalid audience\n${issues}`);
  }
  const a = res.data;
  const id = a.id ?? slugify(path.basename(file).replace(/\.(ya?ml|json)$/i, ""));
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new AudienceError(`${file}: audience id "${id}" may only contain letters, digits, dots, dashes and underscores`);
  return { ...a, id };
}

/** Load one audience from a YAML or JSON file. The id defaults to the file name. */
export async function loadAudience(file: string): Promise<Audience> {
  const text = await fs.readFile(file, "utf8");
  let raw: unknown;
  try {
    raw = /\.json$/i.test(file) ? JSON.parse(text) : YAML.parse(text);
  } catch (e) {
    throw new AudienceError(`${file}: ${(e as Error).message}`);
  }
  return normalize(raw, file);
}

/**
 * Load many audiences. Each input may be a YAML/JSON file, a directory of them, or a CSV
 * (one row per audience; dotted headers such as `contact.first` make nested fields).
 */
export async function loadAudiences(inputs: string[]): Promise<Audience[]> {
  const out: Audience[] = [];
  const seen = new Set<string>();
  const push = (a: Audience, from: string) => {
    if (seen.has(a.id)) throw new AudienceError(`${from}: duplicate audience id "${a.id}"`);
    seen.add(a.id);
    out.push(a);
  };
  for (const input of inputs) {
    if (!(await exists(input))) throw new AudienceError(`audience not found: ${input}`);
    const st = await fs.stat(input);
    if (st.isDirectory()) {
      const entries = (await fs.readdir(input)).filter((n) => /\.(ya?ml|json|csv)$/i.test(n) && !n.startsWith(".")).sort();
      for (const n of entries) for (const a of await loadAudiences([path.join(input, n)])) push(a, path.join(input, n));
    } else if (/\.csv$/i.test(input)) {
      for (const a of parseAudienceCsv(await fs.readFile(input, "utf8"), input)) push(a, input);
    } else {
      push(await loadAudience(input), input);
    }
  }
  return out;
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}

export function parseAudienceCsv(text: string, file = "audiences.csv"): Audience[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells, r) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      const v = (cells[i] ?? "").trim();
      if (!h || v === "") return;
      setPath(obj, h.split("."), v);
    });
    const line = `${file}:${r + 2}`;
    const id = typeof obj.id === "string" && obj.id ? obj.id : slugify(String(obj.company ?? ""));
    return normalize({ ...obj, id }, line);
  });
}

function setPath(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

/* ---------- templating ---------- */

const VAR = /\{\{\s*audience\.([a-zA-Z0-9_.-]+)\s*(?:\|\s*(?:default\()?\s*(?:"([^"]*)"|'([^']*)'|([^}\s)]*))\)?\s*)?\}\}/g;

export function hasAudienceVars(s: string): boolean {
  VAR.lastIndex = 0;
  return VAR.test(s);
}

/** Variable paths referenced by a string, e.g. ["company", "contact.first"]. */
export function audienceVars(value: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(VAR)) out.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return [...out];
}

function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const k of dotted.split(".")) {
    if (cur === null || typeof cur !== "object" || !(k in (cur as Record<string, unknown>))) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * Replace `{{audience.x}}` in a string. `{{audience.x | "fallback"}}` supplies a default.
 * Missing variables without a fallback are collected in `missing`.
 */
export function renderTemplate(s: string, audience: Audience, missing?: Set<string>): string {
  VAR.lastIndex = 0;
  return s.replace(VAR, (_m, key: string, dq?: string, sq?: string, bare?: string) => {
    const v = getPath(audience, key);
    if (v !== undefined && v !== null && v !== "") return typeof v === "object" ? JSON.stringify(v) : String(v);
    const fallback = dq ?? sq ?? bare;
    if (fallback !== undefined) return fallback;
    missing?.add(key);
    return "";
  });
}

function renderDeep<T>(value: T, audience: Audience, missing: Set<string>): T {
  if (typeof value === "string") return renderTemplate(value, audience, missing) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, audience, missing)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = renderDeep(v, audience, missing);
    return out as T;
  }
  return value;
}

export interface PersonalizedFlow {
  /** The flow with every `{{audience.*}}` substituted. `defaults:` is removed. */
  flow: Flow;
  audience: Audience;
  /** Indices of steps whose spec references the audience or that come after an in-app personalized step. */
  personalizedSteps: number[];
  /** True when url, setup or auth depend on the audience: the app state itself is personalized. */
  personalizedState: boolean;
  /** True when the browser must run for this audience (state, overlay or any personalized step). */
  needsCapture: boolean;
  /** Variables the flow references. */
  vars: string[];
}

/** The audience a flow uses when none is given: `defaults:` merged with the id "default". */
export function defaultAudience(flow: Flow): Audience {
  const d = (flow.defaults ?? {}) as Record<string, unknown>;
  const company = typeof d.company === "string" && d.company ? d.company : "Your company";
  return { ...d, company, id: DEFAULT_AUDIENCE_ID } as Audience;
}

/** Merge an audience over the flow's `defaults:` so unset fields fall back to them. */
export function withDefaults(flow: Flow, audience: Audience): Audience {
  const d = (flow.defaults ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...d };
  for (const [k, v] of Object.entries(audience)) {
    if (v && typeof v === "object" && !Array.isArray(v) && merged[k] && typeof merged[k] === "object") merged[k] = { ...(merged[k] as object), ...(v as object) };
    else if (v !== undefined) merged[k] = v;
  }
  return merged as Audience;
}

/**
 * Apply an audience to a flow. Throws when the flow references a variable the audience does not
 * supply (and `defaults:` does not either), naming every missing key.
 */
export function personalizeFlow(flowIn: Flow, audienceIn: Audience): PersonalizedFlow {
  const audience = withDefaults(flowIn, audienceIn);
  const { defaults: _defaults, ...flow } = flowIn;
  const vars = audienceVars(flow);
  const missing = new Set<string>();
  const rendered = renderDeep(flow as Flow, audience, missing);
  if (missing.size) {
    throw new AudienceError(
      `audience "${audience.id}" is missing ${[...missing].map((k) => `audience.${k}`).join(", ")} (referenced by flow "${flowIn.name}"). Add ${missing.size === 1 ? "it" : "them"} to the audience or a \`defaults:\` block in the flow.`
    );
  }
  const personalizedState = [flow.url, flow.setup ?? "", JSON.stringify(flow.auth ?? {})].some(hasAudienceVars);
  const personalizedSteps: number[] = [];
  const overlay = (flow.personalize ?? []).length > 0;
  let cascade = personalizedState;
  flow.steps.forEach((step: StepSpec, i: number) => {
    const refs = audienceVars(step).length > 0;
    // Steps that change app state (fill/type/select/check/press) with audience data personalize everything after them.
    const mutates = refs && (step.fill !== undefined || step.type !== undefined || step.select !== undefined || step.check !== undefined || step.press !== undefined);
    if (refs || cascade || overlay) personalizedSteps.push(i);
    if (mutates) cascade = true;
  });
  return {
    flow: rendered,
    audience,
    personalizedSteps,
    personalizedState,
    needsCapture: personalizedState || overlay || personalizedSteps.length > 0,
    vars
  };
}

/** An audience that supplies every variable a flow references (placeholder values), for analysis. */
export function probeAudience(flow: Flow, base?: Partial<Audience>): Audience {
  const obj: Record<string, unknown> = { ...(base ?? {}), id: "probe", company: base?.company ?? "Probe Co" };
  for (const v of audienceVars(flow)) if (getPath(obj, v) === undefined) setPath(obj, v.split("."), "x");
  return obj as Audience;
}
