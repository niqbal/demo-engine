import { describe, expect, it } from "vitest";
import { parseFlow, stepAction, stringifyFlow, FlowParseError } from "../src/schema.js";

const yaml = `
name: Invite a teammate
url: \${BASE_URL}/settings/team
steps:
  - say: Open team settings.
    click: { role: link, name: Team }
  - say: Enter an email.
    fill: { target: { label: Email }, value: sam@example.com }
    press: Enter
  - say: Confirm.
    click: { css: "button.primary", fallbacks: [{ role: button, name: Send }] }
    expect: { text: Invite sent }
`;

describe("flow schema", () => {
  it("parses a valid flow and infers actions", () => {
    const flow = parseFlow(yaml);
    expect(flow.steps).toHaveLength(3);
    expect(flow.viewport).toEqual({ width: 1440, height: 900 });
    expect(stepAction(flow.steps[0])).toEqual({ kind: "click", target: { role: "link", name: "Team" } });
    expect(stepAction(flow.steps[1]).kind).toBe("fill");
    expect(stepAction(flow.steps[2]).kind).toBe("click");
  });

  it("round-trips through YAML", () => {
    const flow = parseFlow(yaml);
    expect(parseFlow(stringifyFlow(flow))).toEqual(flow);
  });

  it("rejects unknown keys with a readable error", () => {
    expect(() => parseFlow("name: x\nurl: /\nsteps:\n  - say: hi\n    clik: Foo\n", "bad.yaml")).toThrow(FlowParseError);
    expect(() => parseFlow("name: x\nurl: /\nsteps: []\n")).toThrow(/steps/);
  });
});
