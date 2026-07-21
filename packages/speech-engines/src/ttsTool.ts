/**
 * `createTtsSynthesizeTool` — builds the mesh `ToolRegistration` for the
 * `synthesize` tool (`TTS_TOOL_NAME`) from `@unstable-legion/core`'s
 * `speech.ts` contract. Mirrors `asrTool.ts` exactly, reverse direction:
 * text in, base64 WAV out. Takes a minimal `{synthesize}` client so it
 * can be wired to either a real `TtsWorkerClient` (browser) or a fake in
 * unit tests (`test/ttsTool.test.ts`) without pulling in
 * transformers.js/onnxruntime/kokoro-js.
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
        'Synthesize speech audio (base64-encoded WAV) from text using this peer’s local Kokoro TTS engine.',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'Text to synthesize.' },
          voice: { type: 'string', description: 'Optional engine-specific voice id, e.g. af_heart.' },
          language: { type: 'string', description: 'Optional ISO-639-1 language hint.' },
        },
        additionalProperties: false,
      },
    },
    validate: (args) => {
      if (typeof args.text !== 'string' || args.text.trim().length === 0) {
        return 'text must be a non-empty string';
      }
      if (args.voice !== undefined && typeof args.voice !== 'string') {
        return 'voice must be a string';
      }
      if (args.language !== undefined && typeof args.language !== 'string') {
        return 'language must be a string';
      }
      return null;
    },
    handler: async (args) => {
      const content = await client.synthesize({
        text: args.text as string,
        ...(typeof args.voice === 'string' ? { voice: args.voice } : {}),
        ...(typeof args.language === 'string' ? { language: args.language } : {}),
      });
      return { content };
    },
  };
}
