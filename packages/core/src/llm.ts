export interface CompleteOptions {
  system: string;
  user: string;
  json?: boolean;
  maxTokens?: number;
}

export interface LLM {
  name: string;
  complete(opts: CompleteOptions): Promise<string>;
}

export type LLMPreference = "auto" | "anthropic" | "openai" | "none";

export async function createLLM(pref: LLMPreference = "auto"): Promise<LLM | null> {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const pick = pref === "auto" ? (hasAnthropic ? "anthropic" : hasOpenAI ? "openai" : "none") : pref;
  if (pick === "none") return null;
  if (pick === "anthropic") {
    if (!hasAnthropic) throw new Error("ANTHROPIC_API_KEY is not set");
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
    return {
      name: `anthropic:${model}`,
      async complete({ system, user, json, maxTokens }) {
        const res = await client.messages.create({
          model,
          max_tokens: maxTokens ?? 2048,
          system: json ? `${system}\nRespond with JSON only. No prose, no code fences.` : system,
          messages: [{ role: "user", content: user }]
        });
        const text = res.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("")
          .trim();
        return json ? stripFences(text) : text;
      }
    };
  }
  if (!hasOpenAI) throw new Error("OPENAI_API_KEY is not set");
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI();
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  return {
    name: `openai:${model}`,
    async complete({ system, user, json, maxTokens }) {
      const res = await client.chat.completions.create({
        model,
        max_completion_tokens: maxTokens ?? 2048,
        messages: [
          { role: "system", content: json ? `${system}\nRespond with a single JSON object only.` : system },
          { role: "user", content: user }
        ],
        ...(json ? { response_format: { type: "json_object" as const } } : {})
      });
      const text = res.choices[0]?.message?.content?.trim() ?? "";
      return json ? stripFences(text) : text;
    }
  };
}

export function stripFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}

export function parseJsonLoose<T>(s: string): T {
  const t = stripFences(s);
  try {
    return JSON.parse(t) as T;
  } catch {
    const start = t.search(/[{[]/);
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1)) as T;
    throw new Error(`LLM did not return JSON: ${t.slice(0, 200)}`);
  }
}
