import { afterAll, expect, test } from "bun:test";
import { get_encoding } from "tiktoken";
import { estimateTokens } from "../src/lib/token-estimate";

const referenceEncoding = get_encoding("o200k_base");
afterAll(() => referenceEncoding.free());

test("counts GPT-5 text with the o200k tokenizer", () => {
  expect(estimateTokens("hello world")).toBe(2);
});

test("dense encoded context is not under-counted as prose", () => {
  let state = 0x12345678;
  const bytes = Buffer.allocUnsafe(300_000);
  for (let index = 0; index < bytes.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  const encoded = bytes.toString("base64");

  expect(encoded.length).toBe(400_000);
  expect(estimateTokens(encoded)).toBeGreaterThan(256_000);
});

test("pathological repeated text is counted in bounded chunks", () => {
  expect(estimateTokens("a".repeat(32_768))).toBe(4_096);
});

test("large ordinary prose is not inflated by a character-ratio heuristic", () => {
  const prose = `${"word ".repeat(97_999)}word`;
  expect(prose.length).toBe(489_999);
  expect(estimateTokens(prose)).toBeLessThan(100_000);
});

test("repeated chunks retain exact tiktoken counts, including the shorter final chunk", () => {
  const block = " ".repeat(4096);
  const tail = " ".repeat(3536);
  const expected = 109 * referenceEncoding.encode_ordinary(block).length + referenceEncoding.encode_ordinary(tail).length;
  expect(estimateTokens(block.repeat(109) + tail)).toBe(expected);
  expect(expected).toBe(3517);
});

test("surrogate pairs at a chunk boundary retain the same independently encoded boundaries", () => {
  // The pair starts at index 4095, so the first chunk ends before its high surrogate.
  const chunks = ["a".repeat(4095), "😀" + "b".repeat(4094), "c".repeat(4096), "end"];
  const expected = chunks.reduce((total, chunk) => total + referenceEncoding.encode_ordinary(chunk).length, 0);
  expect(estimateTokens(chunks.join(""))).toBe(expected);
  const unpaired = ["x".repeat(4095) + "\uD83D", "y".repeat(4096)];
  expect(estimateTokens(unpaired.join(""))).toBe(unpaired.reduce((total, chunk) => total + referenceEncoding.encode_ordinary(chunk).length, 0));
});

test("more than a cache's worth of distinct chunks and later repetitions preserve exact counts", () => {
  const distinct = Array.from({ length: 80 }, (_, index) => String(index).padStart(6, "0") + "word ".repeat(818));
  const chunks = [...distinct, ...distinct.slice(0, 4), distinct.at(-1)!];
  expect(chunks.every(chunk => chunk.length === 4096)).toBe(true);
  const expected = chunks.reduce((total, chunk) => total + referenceEncoding.encode_ordinary(chunk).length, 0);
  expect(estimateTokens(chunks.join(""))).toBe(expected);
});
