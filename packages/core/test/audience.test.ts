import { describe, expect, it } from "vitest";
import { audienceVars, AudienceError, defaultAudience, parseAudienceCsv, personalizeFlow, probeAudience, renderTemplate, type Audience } from "../src/audience.js";
import { parseFlow } from "../src/schema.js";

const flowYaml = `
name: Onboarding for {{audience.company}}
url: \${BASE_URL}/
defaults:
  company: Acme
  industry_noun: orders
personalize:
  - { css: ".workspace-name", text: "{{audience.company}}" }
steps:
  - say: Open the dashboard.
    click: { role: link, name: Dashboard }
  - say: Import your {{audience.industry_noun}} with one click.
    click: { role: button, name: Import }
  - say: Name the workspace after your team.
    fill: { target: { label: Name }, value: "{{audience.company}} HQ" }
    press: Enter
  - say: Done.
    expect: { text: "{{audience.company}} HQ" }
`;

const acme: Audience = { id: "globex", company: "Globex", industry_noun: "shipments", contact: { first: "Hank" } };

describe("audience templating", () => {
  it("renders variables, nested paths and fallbacks", () => {
    expect(renderTemplate("Hi {{audience.contact.first}} from {{audience.company}}", acme)).toBe("Hi Hank from Globex");
    expect(renderTemplate("{{ audience.missing | \"someone\" }}", acme)).toBe("someone");
    const missing = new Set<string>();
    expect(renderTemplate("{{audience.nope}}", acme, missing)).toBe("");
    expect([...missing]).toEqual(["nope"]);
  });

  it("lists the variables a flow references", () => {
    const flow = parseFlow(flowYaml);
    expect(audienceVars(flow).sort()).toEqual(["company", "industry_noun"]);
  });

  it("personalizes a flow and marks which steps differ per audience", () => {
    const flow = parseFlow(flowYaml);
    const p = personalizeFlow(flow, acme);
    expect(p.flow.name).toBe("Onboarding for Globex");
    expect(p.flow.steps[1].say).toBe("Import your shipments with one click.");
    expect(p.flow.steps[2].fill?.value).toBe("Globex HQ");
    expect(p.flow.personalize?.[0].text).toBe("Globex");
    expect((p.flow as { defaults?: unknown }).defaults).toBeUndefined();
    // Overlay rules make every frame audience-specific.
    expect(p.personalizedSteps).toEqual([0, 1, 2, 3]);
    expect(p.needsCapture).toBe(true);
    expect(p.personalizedState).toBe(false);
  });

  it("without overlay, only referencing steps and what follows a personalized state change differ", () => {
    const flow = parseFlow(flowYaml.replace(/personalize:[\s\S]*?\nsteps:/, "steps:"));
    const p = personalizeFlow(flow, acme);
    // step 1 references, step 2 fills audience data (state change) so step 3 cascades; step 0 is shared.
    expect(p.personalizedSteps).toEqual([1, 2, 3]);
  });

  it("falls back to defaults: and the default audience", () => {
    const flow = parseFlow(flowYaml);
    const d = defaultAudience(flow);
    expect(d).toMatchObject({ id: "default", company: "Acme", industry_noun: "orders" });
    const p = personalizeFlow(flow, { id: "x", company: "Initech" });
    expect(p.flow.steps[1].say).toBe("Import your orders with one click.");
  });

  it("shares capture when nothing the browser sees depends on the audience", () => {
    const flow = parseFlow(`
name: Tour
url: /
steps:
  - say: Welcome, {{audience.company}}.
    click: Start
  - say: That is it.
`);
    const p = personalizeFlow(flow, acme);
    expect(p.personalizedSteps).toEqual([0]);
    expect(p.needsCapture).toBe(true);
    const q = personalizeFlow(parseFlow("name: Tour\nurl: /\nsteps:\n  - say: Welcome.\n    click: Start\n"), acme);
    expect(q.needsCapture).toBe(false);
  });

  it("names every missing variable", () => {
    const flow = parseFlow("name: x\nurl: /\nsteps:\n  - say: '{{audience.company}} in {{audience.region}}'\n");
    expect(() => personalizeFlow(flow, { id: "a", company: "A" })).toThrow(/audience\.region/);
    expect(() => personalizeFlow(flow, { id: "a", company: "A" })).toThrow(AudienceError);
    expect(probeAudience(flow)).toMatchObject({ id: "probe", region: "x" });
  });

  it("loads audiences from CSV with dotted headers", () => {
    const rows = parseAudienceCsv('id,company,industry,contact.first,rep.name\nacme,"Acme, Inc.",Logistics,Jo,Sam\n,Globex,,Hank,\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "acme", company: "Acme, Inc.", industry: "Logistics", contact: { first: "Jo" }, rep: { name: "Sam" } });
    expect(rows[1].id).toBe("globex");
    expect(rows[1].industry).toBeUndefined();
  });
});
