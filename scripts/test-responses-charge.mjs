#!/usr/bin/env node
// Unit test: Responses API SSE usage extraction.
// Verifies P0-1 fix — extractResponsesUsageStream parses input_tokens/output_tokens
// from response.completed event.data.response.usage.

import assert from "node:assert/strict";
import {
  extractResponsesUsageStream,
  extractResponsesUsageNonStream,
  extractUsageStream,
} from "../lib/openai-protocol.mjs";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

console.log("Responses API usage extraction:");

t("stream: response.completed yields usage", () => {
  const sse = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_1"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Hi"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":42,"output_tokens":7}}}',
    '',
  ].join("\n");
  const u = extractResponsesUsageStream(sse);
  assert.deepEqual(u, { input: 42, output: 7 });
});

t("stream: prompt_tokens/completion_tokens fallback also works", () => {
  const sse = [
    'event: response.completed',
    'data: {"response":{"usage":{"prompt_tokens":11,"completion_tokens":3}}}',
    '',
  ].join("\n");
  const u = extractResponsesUsageStream(sse);
  assert.deepEqual(u, { input: 11, output: 3 });
});

t("stream: top-level usage on event also works", () => {
  const sse = ['data: {"usage":{"input_tokens":5,"output_tokens":1}}', ''].join("\n");
  assert.deepEqual(extractResponsesUsageStream(sse), { input: 5, output: 1 });
});

t("stream: returns null when no usage found", () => {
  const sse = 'data: {"type":"foo"}\n';
  assert.equal(extractResponsesUsageStream(sse), null);
});

t("non-stream: top-level usage", () => {
  const body = JSON.stringify({ id: "resp_2", usage: { input_tokens: 9, output_tokens: 2 } });
  assert.deepEqual(extractResponsesUsageNonStream(body), { input: 9, output: 2 });
});

t("non-stream: nested response.usage", () => {
  const body = JSON.stringify({ response: { usage: { input_tokens: 4, output_tokens: 0 } } });
  assert.deepEqual(extractResponsesUsageNonStream(body), { input: 4, output: 0 });
});

t("regression: chat-completions extractor unchanged (flat evt.usage)", () => {
  const sse = 'data: {"usage":{"prompt_tokens":12,"completion_tokens":8}}\ndata: [DONE]\n';
  assert.deepEqual(extractUsageStream(sse), { input: 12, output: 8 });
});

t("regression: chat-completions extractor returns null for Responses-shaped SSE", () => {
  // Demonstrates the original bug: old extractor cannot read Responses API events.
  const sse = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":10}}}\n';
  assert.equal(extractUsageStream(sse), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
