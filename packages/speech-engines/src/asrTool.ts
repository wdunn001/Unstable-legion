/**
 * `createAsrTranscribeTool` — builds the mesh `ToolRegistration` for the
 * `transcribe` tool (`ASR_TOOL_NAME`) from `@unstable-legion/core`'s
 * `speech.ts` contract. Takes a minimal `{transcribe}` client so it can
 * be wired to either a real `SpeechWorkerClient` (browser) or a fake in
 * unit tests (`test/asrTool.test.ts`) without pulling in
 * transformers.js/onnxruntime.
 */
import {
  ASR_TOOL_NAME,
  type AsrTranscribeArgs,
  type AsrTranscribeContent,
} from '@unstable-legion/core';
import type { ToolRegistration } from '@unstable-legion/core';

export interface AsrTranscribeClient {
  transcribe(args: AsrTranscribeArgs): Promise<AsrTranscribeContent>;
}

export function createAsrTranscribeTool(client: AsrTranscribeClient): ToolRegistration {
  return {
    descriptor: {
      name: ASR_TOOL_NAME,
      description:
        'Transcribe a base64-encoded audio clip to text using this peer’s local Whisper engine.',
      inputSchema: {
        type: 'object',
        required: ['audioBase64', 'mimeType'],
        properties: {
          audioBase64: { type: 'string', description: 'Base64-encoded audio clip bytes.' },
          mimeType: { type: 'string', description: 'Container/codec mime type, e.g. audio/webm.' },
          language: { type: 'string', description: 'Optional ISO-639-1 language hint.' },
        },
        additionalProperties: false,
      },
    },
    validate: (args) => {
      if (typeof args.audioBase64 !== 'string' || args.audioBase64.length === 0) {
        return 'audioBase64 must be a non-empty string';
      }
      if (typeof args.mimeType !== 'string' || args.mimeType.length === 0) {
        return 'mimeType must be a non-empty string';
      }
      if (args.language !== undefined && typeof args.language !== 'string') {
        return 'language must be a string';
      }
      return null;
    },
    handler: async (args) => {
      const content = await client.transcribe({
        audioBase64: args.audioBase64 as string,
        mimeType: args.mimeType as string,
        ...(typeof args.language === 'string' ? { language: args.language } : {}),
      });
      return { content };
    },
  };
}
