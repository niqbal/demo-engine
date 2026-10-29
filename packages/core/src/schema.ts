import { z } from "zod";
import YAML from "yaml";

/**
 * Locator spec. User-facing locators first (role/label/text), anchors
 * (`data-demo="..."`) for apps that opt in, raw CSS as the escape hatch.
 */
export interface LocatorObject {
  role?: string;
  name?: string;
  exact?: boolean;
  label?: string;
  text?: string;
  placeholder?: string;
  testid?: string;
  anchor?: string;
  css?: string;
  nth?: number;
  fallbacks?: LocatorSpec[];
}
export type LocatorSpec = string | LocatorObject;

export const LocatorObjectSchema: z.ZodType<LocatorObject> = z.lazy(() =>
  z
    .object({
      role: z.string().optional(),
      name: z.string().optional(),
      exact: z.boolean().optional(),
      label: z.string().optional(),
      text: z.string().optional(),
      placeholder: z.string().optional(),
      testid: z.string().optional(),
      anchor: z.string().optional(),
      css: z.string().optional(),
      nth: z.number().int().optional(),
      fallbacks: z.array(LocatorSchema).optional()
    })
    .strict()
);

export const LocatorSchema: z.ZodType<LocatorSpec> = z.lazy(() => z.union([z.string(), LocatorObjectSchema]));

export const ExpectSchema = z
  .object({
    text: z.string().optional(),
    visible: LocatorSchema.optional(),
    hidden: LocatorSchema.optional(),
    url: z.string().optional()
  })
  .strict();
export type ExpectSpec = z.infer<typeof ExpectSchema>;

export const ZoomSchema = z
  .object({
    on: LocatorSchema.optional(),
    scale: z.number().min(1).max(4).default(1.6)
  })
  .strict();

export const StepSchema = z
  .object({
    id: z.string().optional(),
    say: z.string().min(1),
    goto: z.string().optional(),
    click: LocatorSchema.optional(),
    dblclick: LocatorSchema.optional(),
    hover: LocatorSchema.optional(),
    fill: z
      .object({ target: LocatorSchema.optional(), value: z.string() })
      .passthrough()
      .optional(),
    type: z
      .object({ target: LocatorSchema.optional(), value: z.string(), delay: z.number().optional() })
      .passthrough()
      .optional(),
    select: z
      .object({ target: LocatorSchema.optional(), option: z.string() })
      .passthrough()
      .optional(),
    check: LocatorSchema.optional(),
    press: z.string().optional(),
    scroll: LocatorSchema.optional(),
    wait: z.union([z.number(), LocatorSchema]).optional(),
    expect: ExpectSchema.optional(),
    zoom: ZoomSchema.optional(),
    mask: z.array(z.string()).optional(),
    pause: z.number().optional(),
    highlight: LocatorSchema.optional()
  })
  .strict();
export type StepSpec = z.infer<typeof StepSchema>;

export const AuthSchema = z
  .object({
    storageState: z.string().optional(),
    login: z.string().optional()
  })
  .strict();

/**
 * A DOM rewrite applied before every screenshot of a personalized run (Layer 2 personalization:
 * the app itself is not seeded, the page is repainted). Values accept `{{audience.*}}`.
 */
export const PersonalizeRuleSchema = z
  .object({
    css: z.string().min(1),
    text: z.string().optional(),
    src: z.string().optional(),
    html: z.string().optional(),
    style: z.string().optional(),
    attr: z.record(z.string(), z.string()).optional(),
    /** Rewrite every match (default) or only the first. */
    all: z.boolean().default(true)
  })
  .strict();
export type PersonalizeRule = z.infer<typeof PersonalizeRuleSchema>;

export const EndCardSchema = z
  .object({
    text: z.string().optional(),
    url: z.string().optional()
  })
  .strict();

export const FlowSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    url: z.string().min(1),
    auth: AuthSchema.optional(),
    viewport: z
      .object({ width: z.number().int().default(1440), height: z.number().int().default(900) })
      .default({ width: 1440, height: 900 }),
    voice: z.string().optional(),
    touches: z.array(z.string()).optional(),
    setup: z.string().optional(),
    mask: z.array(z.string()).optional(),
    /** Default audience values. CI, diff and heal run with these; `--audience` overrides them per prospect. */
    defaults: z.record(z.string(), z.unknown()).optional(),
    /** DOM rewrites applied before each screenshot (see PersonalizeRuleSchema). */
    personalize: z.array(PersonalizeRuleSchema).optional(),
    /** Closing card. Shown when set, or when the audience names a rep. */
    end: EndCardSchema.optional(),
    steps: z.array(StepSchema).min(1)
  })
  .strict();
export type Flow = z.infer<typeof FlowSchema>;

export const ConfigSchema = z
  .object({
    baseUrl: z.string().optional(),
    out: z.string().default(".demo-engine"),
    demos: z.string().default("demos"),
    voice: z.string().optional(),
    tts: z.enum(["auto", "openai", "elevenlabs", "kokoro", "say", "silent"]).default("auto"),
    llm: z.enum(["auto", "anthropic", "openai", "none"]).default("auto"),
    glossary: z.string().optional(),
    fps: z.number().int().default(30),
    captions: z.boolean().default(true),
    brand: z
      .object({
        accent: z.string().default("#4F46E5"),
        background: z.string().default("#0B0F19"),
        title: z.string().optional(),
        logo: z.string().optional(),
        /** Default end-card text, e.g. "Book a walkthrough". Audience `rep` fills in the person. */
        cta: z.string().optional(),
        url: z.string().optional()
      })
      .partial()
      .optional(),
    /** Where `--audiences` looks when given a bare name; default `<demos>/audiences`. */
    audiences: z.string().optional()
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;

export class FlowParseError extends Error {
  constructor(public file: string, message: string) {
    super(`${file}: ${message}`);
  }
}

export function parseFlow(yamlText: string, file = "flow.yaml"): Flow {
  let raw: unknown;
  try {
    raw = YAML.parse(yamlText);
  } catch (e) {
    throw new FlowParseError(file, `invalid YAML: ${(e as Error).message}`);
  }
  const res = FlowSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new FlowParseError(file, `invalid flow\n${issues}`);
  }
  return res.data;
}

export function parseConfig(yamlText: string, file = "demo-engine.config.yaml"): Config {
  const raw = YAML.parse(yamlText) ?? {};
  const res = ConfigSchema.safeParse(raw);
  if (!res.success) {
    throw new FlowParseError(file, res.error.issues.map((i) => i.message).join("; "));
  }
  return res.data;
}

export function stringifyFlow(flow: Flow): string {
  return YAML.stringify(flow, { lineWidth: 100 });
}

/** Which action a step performs, if any. */
export type ActionKind =
  | "goto" | "click" | "dblclick" | "hover" | "fill" | "type" | "select"
  | "check" | "press" | "scroll" | "wait" | "none";

export function stepAction(step: StepSpec): { kind: ActionKind; target?: LocatorSpec } {
  if (step.goto !== undefined) return { kind: "goto" };
  if (step.click !== undefined) return { kind: "click", target: step.click };
  if (step.dblclick !== undefined) return { kind: "dblclick", target: step.dblclick };
  if (step.fill !== undefined) return { kind: "fill", target: step.fill.target };
  if (step.type !== undefined) return { kind: "type", target: step.type.target };
  if (step.select !== undefined) return { kind: "select", target: step.select.target };
  if (step.check !== undefined) return { kind: "check", target: step.check };
  if (step.hover !== undefined) return { kind: "hover", target: step.hover };
  if (step.scroll !== undefined) return { kind: "scroll", target: step.scroll };
  if (step.press !== undefined) return { kind: "press" };
  if (step.wait !== undefined) return { kind: "wait", target: typeof step.wait === "number" ? undefined : step.wait };
  return { kind: "none", target: step.highlight };
}
