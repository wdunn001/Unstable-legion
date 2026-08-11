/**
 * `createTtsSynthesizeTool` — builds the mesh `ToolRegistration` for the
 * `synthesize` tool (`TTS_TOOL_NAME`) from `@unstable-legion/core`'s
 * `speech.ts` contract. Takes a minimal `{synthesize}` client so it can
 * be wired to either a real `TtsWorkerClient` (browser) or a fake in
 * unit tests (`test/ttsTool.test.ts`) without pulling in kokoro-js/
 * onnxruntime. Mirrors `asrTool.ts`'s `createAsrTranscribeTool` exactly.
 */
import {
  TTS_TOOL_NAME,
  type TtsSynthesizeArgs,
  type TtsSynthesizeContent,
} from '@unstable-legion/core';
import type { ToolRegistration } from '@unstable-legion/core';

export interface TtsSynthesizeClient {
  synthesize(args: TtsSynthesizeArgs): Promise<TtsSynthesizeContent>;
}

export function createTtsSynthesizeTool(client: TtsSynthesizeClient): ToolRegistration {
  return {
    descriptor: {
      name: TTS_TOOL_NAME,
      description:
        'Synthesize speech from text using this peer’s local Kokoro TTS engine, returning a base64-encoded WAV clip.',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'Text to synthesize.' },
          voice: { type: 'string', description: 'Optional engine-specific voice id, e.g. af_heart.' },
          speed: { type: 'number', description: 'Optional speaking-speed multiplier (1.0 = normal).' },
        },
        additionalProperties: false,
      },
    },
    validate: (args) => {
      if (typeof args.text !== 'string' || args.text.length === 0) {
        return 'text must be a non-empty string';
      }
      if (args.voice !== undefined && typeof args.voice !== 'string') {
        return 'voice must be a string';
      }
      if (args.speed !== undefined && typeof args.speed !== 'number') {
        return 'speed must be a number';
      }
      return null;
    },
    handler: async (args) => {
      const content = await client.synthesize({
        text: args.text as string,
        ...(typeof args.voice === 'string' ? { voice: args.voice } : {}),
        ...(typeof args.speed === 'number' ? { speed: args.speed } : {}),
      });
      return { content };
    },
  };
}
