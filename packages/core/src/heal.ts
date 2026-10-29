import { promises as fs } from "node:fs";
import path from "node:path";
import { describeLocator } from "./locators.js";
import { parseJsonLoose, type LLM } from "./llm.js";
import { runFlow, type RunOptions, type RunResult } from "./runner.js";
import { LocatorObjectSchema, stepAction, type Flow, type LocatorObject, type LocatorSpec, type StepSpec } from "./schema.js";
import { silentLogger, type Logger } from "./util.js";

export interface Heal {
  stepIndex: number;
  via?: string;
  say: string;
  from: LocatorSpec;
  to: LocatorObject;
  confidence: number;
  reason: string;
  verified: boolean;
}

export interface HealResult {
  flow: Flow;
  run: RunResult;
  heals: Heal[];
  /** Steps that are still broken after healing. */
  unresolved: number[];
}

export interface HealOptions extends RunOptions {
  /** When absent (or when the model fails), a heuristic matcher over the accessibility tree is used. */
  llm?: LLM | null;
  maxRounds?: number;
  minConfidence?: number;
  /** Baseline run, used to show the model what the element looked like before. */
  baseline?: RunResult;
  logger?: Logger;
}

const SYSTEM = `You repair element locators in a scripted product walkthrough after the product's UI changed.
You are given the step's intent, the action, the locator that used to work, an excerpt of the OLD accessibility tree
(if available) and the NEW accessibility tree of the page. Choose the single element on the NEW page that best matches
the intent. Prefer user-facing locators in this order: role+name, label, placeholder, text, testid, css.
Return JSON: {"locator": {...}, "confidence": 0..1, "reason": "short"}.
The locator object may contain: role, name, exact, label, placeholder, text, testid, css, nth.
If no element matches the intent, return {"locator": null, "confidence": 0, "reason": "..."}.`;

function setTarget(step: StepSpec, target: LocatorObject): StepSpec {
  const kind = stepAction(step).kind;
  const s: StepSpec = { ...step };
  switch (kind) {
    case "click": s.click = target; break;
    case "dblclick": s.dblclick = target; break;
    case "hover": s.hover = target; break;
    case "check": s.check = target; break;
    case "scroll": s.scroll = target; break;
    case "fill": s.fill = { ...s.fill!, target }; break;
    case "type": s.type = { ...s.type!, target }; break;
    case "select": s.select = { ...s.select!, target }; break;
    case "wait": s.wait = target; break;
    default: s.highlight = target;
  }
  return s;
}

function withFallback(next: LocatorObject, old: LocatorSpec): LocatorObject {
  const oldObj: LocatorObject = typeof old === "string" ? { css: old } : old;
  const { fallbacks: oldFallbacks, ...oldPrimary } = oldObj;
  const fallbacks: LocatorSpec[] = [oldPrimary, ...(oldFallbacks ?? [])].filter(
    (f) => JSON.stringify(f) !== JSON.stringify(next)
  );
  return fallbacks.length ? { ...next, fallbacks: fallbacks.slice(0, 3) } : next;
}

export function firstHealable(run: RunResult): number {
  return run.steps.findIndex(
    (s) => s.error && !s.cascade && (s.resolution?.status === "missing" || s.resolution?.status === "ambiguous")
  );
}

export async function proposeLocator(
  llm: LLM,
  flow: Flow,
  step: StepSpec,
  run: RunResult,
  stepIndex: number,
  baseline?: RunResult
): Promise<{ locator: LocatorObject | null; confidence: number; reason: string }> {
  const sr = run.steps[stepIndex];
  const act = stepAction(step);
  const newAria = (await fs.readFile(path.join(run.runDir, sr.aria), "utf8").catch(() => "")).slice(0, 14000);
  const oldAria = baseline?.steps[stepIndex]
    ? (await fs.readFile(path.join(baseline.runDir, baseline.steps[stepIndex].aria), "utf8").catch(() => "")).slice(0, 4000)
    : "";
  const user = [
    `Flow: ${flow.name}`,
    `Step ${stepIndex + 1} intent: ${step.say}`,
    `Action: ${act.kind}${act.kind === "fill" ? ` (value: ${step.fill?.value})` : ""}${act.kind === "select" ? ` (option: ${step.select?.option})` : ""}`,
    `Old locator: ${act.target !== undefined ? describeLocator(act.target) : "(none)"}`,
    `Failure: ${sr.error ?? sr.resolution?.status}`,
    oldAria ? `\nOLD accessibility tree (excerpt):\n${oldAria}` : "",
    `\nNEW accessibility tree:\n${newAria || "(empty)"}`
  ].join("\n");
  const raw = await llm.complete({ system: SYSTEM, user, json: true, maxTokens: 600 });
  const parsed = parseJsonLoose<{ locator: unknown; confidence?: number; reason?: string }>(raw);
  if (!parsed.locator) return { locator: null, confidence: 0, reason: parsed.reason ?? "no match" };
  const loc = LocatorObjectSchema.safeParse(parsed.locator);
  if (!loc.success) return { locator: null, confidence: 0, reason: `model returned an invalid locator: ${raw.slice(0, 120)}` };
  return { locator: loc.data, confidence: Number(parsed.confidence ?? 0), reason: parsed.reason ?? "" };
}

const ROLE_FOR_ACTION: Record<string, string[]> = {
  click: ["button", "link", "checkbox", "menuitem", "tab", "radio", "switch", "option", "treeitem", "img"],
  dblclick: ["button", "link", "listitem", "cell", "img"],
  hover: ["button", "link", "menuitem", "img"],
  check: ["checkbox", "radio", "switch"],
  fill: ["textbox", "searchbox", "combobox", "spinbutton"],
  type: ["textbox", "searchbox", "combobox", "spinbutton"],
  select: ["combobox", "listbox"],
  scroll: [],
  wait: [],
  none: []
};

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP.has(t))
  );
}
const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "it", "is", "this", "that", "your", "you", "with", "for", "then", "click", "press", "open", "select", "choose", "type", "enter", "tap"]);

function oldName(spec: LocatorSpec | undefined): { role?: string; name: string } {
  if (spec === undefined) return { name: "" };
  if (typeof spec === "string") return { name: spec.replace(/[\[\]"'=#.]/g, " ") };
  return { role: spec.role, name: spec.name ?? spec.label ?? spec.text ?? spec.placeholder ?? spec.testid ?? spec.anchor ?? spec.css ?? "" };
}

/**
 * Offline healer: scan the new accessibility snapshot for elements whose
 * role fits the action and whose name overlaps the old locator or the
 * step's wording. Good enough for renames and moved buttons; the LLM
 * path handles the rest.
 */
export async function proposeLocatorHeuristic(
  step: StepSpec,
  run: RunResult,
  stepIndex: number
): Promise<{ locator: LocatorObject | null; confidence: number; reason: string }> {
  const sr = run.steps[stepIndex];
  const act = stepAction(step);
  const aria = await fs.readFile(path.join(run.runDir, sr.aria), "utf8").catch(() => "");
  const roles = ROLE_FOR_ACTION[act.kind] ?? [];
  const old = oldName(act.target);
  const oldTok = tokens(old.name);
  const sayTok = tokens(step.say);
  const seen = new Map<string, number>();
  const candidates: { role: string; name: string; score: number }[] = [];
  for (const line of aria.split("\n")) {
    const m = line.match(/^\s*-\s+([a-z]+)\s+"([^"]+)"/);
    if (!m) continue;
    const [, role, name] = m;
    const key = `${role}\u0000${name}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (roles.length && !roles.includes(role)) continue;
    const nt = tokens(name);
    if (nt.size === 0) continue;
    let overlapOld = 0;
    for (const t of nt) if (oldTok.has(t)) overlapOld++;
    let overlapSay = 0;
    for (const t of nt) if (sayTok.has(t)) overlapSay++;
    const denom = Math.max(nt.size, 1);
    let score = (overlapOld / denom) * 0.7 + (overlapSay / denom) * 0.5;
    if (old.role && old.role === role) score += 0.1;
    if (name.toLowerCase() === old.name.toLowerCase()) score = 1;
    if (score > 0) candidates.push({ role, name, score: Math.min(1, score) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return { locator: null, confidence: 0, reason: "no candidate element with a matching role and name" };
  const dup = (seen.get(`${best.role}\u0000${best.name}`) ?? 1) > 1;
  const locator: LocatorObject = { role: best.role, name: best.name, exact: true, ...(dup ? { nth: 0 } : {}) };
  return {
    locator,
    confidence: best.score,
    reason: `heuristic: ${best.role} "${best.name}" overlaps ${old.name ? `old locator "${old.name}"` : "the step wording"}${dup ? " (first of several)" : ""}`
  };
}

async function propose(opts: HealOptions, flow: Flow, step: StepSpec, run: RunResult, idx: number, log: Logger) {
  if (opts.llm) {
    try {
      const p = await proposeLocator(opts.llm, flow, step, run, idx, opts.baseline);
      if (p.locator) return { ...p, via: opts.llm.name };
      log.warn(`heal: model found no match (${p.reason}); trying heuristic`);
    } catch (e) {
      log.warn(`heal: model error (${(e as Error).message.split("\n")[0]}); trying heuristic`);
    }
  }
  return { ...(await proposeLocatorHeuristic(step, run, idx)), via: "heuristic" };
}

/**
 * Heal loop: run, find the first broken step whose locator failed, ask the
 * model for a replacement, re-run with the patched step, repeat.
 * Never writes the flow file; the caller decides what to do with `flow`.
 */
export async function healFlow(flow: Flow, failedRun: RunResult, opts: HealOptions): Promise<HealResult> {
  const log = opts.logger ?? silentLogger;
  const maxRounds = opts.maxRounds ?? 3;
  const minConfidence = opts.minConfidence ?? 0.5;
  let current: Flow = flow;
  let run = failedRun;
  const heals: Heal[] = [];
  for (let round = 0; round < maxRounds; round++) {
    const idx = firstHealable(run);
    if (idx < 0) break;
    const step = current.steps[idx];
    const act = stepAction(step);
    log.info(`heal: step ${idx + 1} "${step.say.slice(0, 60)}" (${run.steps[idx].error})`);
    const proposal = await propose(opts, current, step, run, idx, log);
    if (!proposal.locator || proposal.confidence < minConfidence) {
      log.warn(`heal: no confident replacement (${proposal.confidence.toFixed(2)}): ${proposal.reason}`);
      heals.push({
        stepIndex: idx,
        say: step.say,
        from: act.target ?? "",
        to: proposal.locator ?? {},
        confidence: proposal.confidence,
        reason: proposal.reason,
        verified: false
      });
      break;
    }
    const patched = withFallback(proposal.locator, act.target ?? "");
    const steps = current.steps.map((s, i) => (i === idx ? setTarget(s, patched) : s));
    const trial: Flow = { ...current, steps };
    log.info(`heal: trying ${describeLocator(proposal.locator)} via ${proposal.via} (confidence ${proposal.confidence.toFixed(2)})`);
    const rerun = await runFlow(trial, { ...opts, stepsOverride: undefined });
    const ok = !rerun.steps[idx]?.error;
    heals.push({
      stepIndex: idx,
      say: step.say,
      from: act.target ?? "",
      to: patched,
      confidence: proposal.confidence,
      reason: proposal.reason,
      verified: ok,
      via: proposal.via
    });
    if (!ok) {
      log.warn(`heal: replacement did not work (${rerun.steps[idx]?.error})`);
      run = rerun;
      break;
    }
    current = trial;
    run = rerun;
    if (run.status === "passed") break;
  }
  const unresolved = run.steps.filter((s) => s.error).map((s) => s.index);
  return { flow: current, run, heals, unresolved };
}

/**
 * Re-apply verified heals to another copy of the flow, e.g. the untemplated file on disk after
 * healing ran on the default-audience rendering of it. Locators do not carry `{{audience.*}}`
 * values in practice, so the patched locator is copied as is.
 */
export function applyHeals(flow: Flow, heals: Heal[]): Flow {
  const steps = flow.steps.map((s, i) => {
    const h = heals.filter((x) => x.verified && x.stepIndex === i).pop();
    return h ? setTarget(s, h.to) : s;
  });
  return { ...flow, steps };
}
