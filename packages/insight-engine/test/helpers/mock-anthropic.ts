/**
 * Shared mock Anthropic client used by every per-agent unit test.
 *
 * The mock client implements just enough surface area for `claude.ts`:
 *   - `messages.create()` — returns a canned response.
 *   - The response is wired up so the structured-output JSON sits in the
 *     final text block (matches what real Anthropic does when `output_config.format`
 *     is set).
 *
 * We do NOT mock the SDK at the module-import level (vi.mock). Instead we
 * use `setClient()` which we exposed for exactly this purpose — it keeps
 * the wiring honest (real claude.ts code path, fake API).
 */

import type Anthropic from "@anthropic-ai/sdk";
import { vi } from "vitest";

export interface MockResponseSpec {
  /** Object that will be JSON.stringified into the final text block. */
  traceFields: Record<string, unknown>;
  /** Optional tool_use blocks to emit BEFORE the final text. Triggers loop. */
  toolUseBlocks?: Array<{ id: string; name: string; input: unknown }>;
  /** Override the stop_reason. Defaults to "end_turn". */
  stopReason?: Anthropic.Message["stop_reason"];
  /** Override token usage. */
  usage?: Partial<Anthropic.Usage>;
}

function buildMessage(spec: MockResponseSpec): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];

  if (spec.toolUseBlocks) {
    for (const tu of spec.toolUseBlocks) {
      content.push({
        type: "tool_use",
        id: tu.id,
        name: tu.name,
        input: tu.input,
      } as unknown as Anthropic.ToolUseBlock);
    }
  }

  content.push({
    type: "text",
    text: JSON.stringify(spec.traceFields),
    citations: [] as never,
  } as unknown as Anthropic.TextBlock);

  return {
    id: "msg_mock_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content,
    stop_reason: spec.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 60,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...spec.usage,
    } as Anthropic.Usage,
    container: null,
  } as unknown as Anthropic.Message;
}

/**
 * Build a mock client whose `messages.create()` returns the supplied
 * sequence of responses in order (one response per call). After the last
 * response, subsequent calls throw — surfaces accidental extra calls.
 *
 * For the simple case (no tool loop), pass a single response.
 */
export function makeMockClient(
  responseSequence: MockResponseSpec[],
): {
  client: Anthropic;
  createMock: ReturnType<typeof vi.fn>;
} {
  const responses = [...responseSequence];
  const createMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error(
        "Mock Anthropic.messages.create() was called more times than the test scripted.",
      );
    }
    return buildMessage(next);
  });

  const client = {
    messages: { create: createMock },
  } as unknown as Anthropic;

  return { client, createMock };
}
