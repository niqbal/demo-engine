import type { Locator, Page } from "playwright";
import type { LocatorObject, LocatorSpec } from "./schema.js";

export type ResolutionStatus = "found" | "ambiguous" | "missing";

export interface Resolution {
  status: ResolutionStatus;
  count: number;
  /** Which spec actually matched (primary or one of the fallbacks). */
  used?: LocatorSpec;
  usedIndex: number; // 0 = primary, 1.. = fallbacks
  locator?: Locator;
  description: string;
}

/** Build a Playwright Locator from a spec (no fallbacks applied here). */
export function toLocator(page: Page, spec: LocatorSpec): Locator {
  if (typeof spec === "string") return page.locator(spec);
  const o = spec;
  let loc: Locator;
  if (o.anchor) loc = page.locator(`[data-demo="${cssEscape(o.anchor)}"]`);
  else if (o.testid) loc = page.getByTestId(o.testid);
  else if (o.role) loc = page.getByRole(o.role as Parameters<Page["getByRole"]>[0], {
    name: o.name,
    exact: o.exact
  });
  else if (o.label) loc = page.getByLabel(o.label, { exact: o.exact });
  else if (o.placeholder) loc = page.getByPlaceholder(o.placeholder, { exact: o.exact });
  else if (o.text) loc = page.getByText(o.text, { exact: o.exact });
  else if (o.css) loc = page.locator(o.css);
  else throw new Error(`Empty locator spec: ${JSON.stringify(o)}`);
  if (o.nth !== undefined) loc = loc.nth(o.nth);
  return loc;
}

export function describeLocator(spec: LocatorSpec): string {
  if (typeof spec === "string") return `css "${spec}"`;
  const o = spec;
  const parts: string[] = [];
  if (o.anchor) parts.push(`anchor "${o.anchor}"`);
  if (o.testid) parts.push(`testid "${o.testid}"`);
  if (o.role) parts.push(`role ${o.role}${o.name ? ` "${o.name}"` : ""}`);
  if (o.label) parts.push(`label "${o.label}"`);
  if (o.placeholder) parts.push(`placeholder "${o.placeholder}"`);
  if (o.text) parts.push(`text "${o.text}"`);
  if (o.css) parts.push(`css "${o.css}"`);
  if (o.nth !== undefined) parts.push(`nth ${o.nth}`);
  return parts.join(" ") || "(empty)";
}

function candidates(spec: LocatorSpec): LocatorSpec[] {
  if (typeof spec === "string") return [spec];
  const { fallbacks, ...primary } = spec;
  const list: LocatorSpec[] = [primary as LocatorObject];
  for (const f of fallbacks ?? []) list.push(...candidates(f));
  return list;
}

/**
 * Resolve a spec, trying the primary then each fallback until exactly one
 * element matches. Ambiguous (>1) primaries are reported but we still
 * fall through to fallbacks since a fallback may be more specific.
 */
export async function resolveLocator(page: Page, spec: LocatorSpec, timeoutMs = 5000): Promise<Resolution> {
  const list = candidates(spec);
  let firstAmbiguous: Resolution | undefined;
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; i < list.length; i++) {
    const cand = list[i];
    const loc = toLocator(page, cand);
    let count = 0;
    // Poll briefly: SPAs render late.
    while (true) {
      count = await loc.count();
      if (count > 0 || Date.now() > deadline) break;
      await page.waitForTimeout(100);
    }
    if (count === 1) {
      return { status: "found", count, used: cand, usedIndex: i, locator: loc, description: describeLocator(cand) };
    }
    if (count > 1 && !firstAmbiguous) {
      firstAmbiguous = { status: "ambiguous", count, used: cand, usedIndex: i, locator: loc.first(), description: describeLocator(cand) };
    }
  }
  if (firstAmbiguous) return firstAmbiguous;
  return { status: "missing", count: 0, usedIndex: -1, description: describeLocator(list[0]) };
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
