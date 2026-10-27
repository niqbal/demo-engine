import { describe, expect, it } from "vitest";
import { createTTS, pcmToWav, wavDurationMs } from "../src/tts.js";

describe("wav", () => {
  it("computes duration from the header", () => {
    const pcm = Buffer.alloc(22050 * 2 * 3); // 3s mono 16-bit @22050
    expect(wavDurationMs(pcmToWav(pcm, 22050, 1))).toBe(3000);
  });
  it("silent provider scales with word count", async () => {
    const tts = createTTS("silent");
    const short = wavDurationMs(await tts.synthesize("Hi there."));
    const long = wavDurationMs(await tts.synthesize("This sentence has quite a few more words in it than the other one does."));
    expect(long).toBeGreaterThan(short);
  });
});
