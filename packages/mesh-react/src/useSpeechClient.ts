/**
 * useSpeechClient — ask for a transcript, locally or over the mesh.
 *
 * Base64-encodes the recorded clip, then resolves a target in priority
 * order:
 *   1. This peer's own ASR host (`opts.transcribeLocal`, if provided) —
 *      no mesh round-trip, solo mode included.
 *   2. The first roster peer (via `useMeshRoster()`) advertising
 *      `ASR_SKILL` in `skills[]`, via `callTool(peerId, ASR_TOOL_NAME, args)`.
 * Throws a clear error if neither is available. The resolved content
 * carries an extra `via` field (`'local'` or the serving peer's id) so a
 * UI can show which path served the request — a strict superset of
 * `AsrTranscribeContent`, so it's still assignable wherever the bare
 * contract type is expected.
 */
import { useCallback, useMemo } from 'react';
import {
  ASR_SKILL,
  ASR_TOOL_NAME,
  type AsrTranscribeArgs,
  type AsrTranscribeContent,
  type MeshToolResult,
} from '@unstable-legion/core';

import { useMeshContext } from './provider.js';
import { useMeshRoster } from './useMeshRoster.js';

export interface SpeechClientClip {
  bytes: ArrayBuffer;
  mimeType: string;
}

export type CallToolFn = (
  peerId: string,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  timeoutMs?: number,
) => Promise<MeshToolResult>;

export interface UseSpeechClientOptions {
  /** `useMeshTools().callTool` — used when no local ASR host is available. */
  callTool: CallToolFn;
  /** `useSpeechHost().transcribeLocal`, when this peer hosts ASR itself. Omit/undefined = always route to a remote peer. */
  transcribeLocal?: (args: AsrTranscribeArgs) => Promise<AsrTranscribeContent>;
}

export type AsrTranscribeContentWithSource = AsrTranscribeContent & { via: 'local' | string };

export interface UseSpeechClientHandle {
  transcribe: (clip: SpeechClientClip, language?: string) => Promise<AsrTranscribeContentWithSource>;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

export function useSpeechClient(opts: UseSpeechClientOptions): UseSpeechClientHandle {
  const { callTool, transcribeLocal } = opts;
  const { peer } = useMeshContext();
  const roster = useMeshRoster();

  const findAsrPeer = useMemo(
    () => () => roster.find((r) => r.peerId !== peer?.selfId && r.skills.includes(ASR_SKILL)),
    [roster, peer],
  );

  const transcribe = useCallback(
    async (clip: SpeechClientClip, language?: string): Promise<AsrTranscribeContentWithSource> => {
      const args: AsrTranscribeArgs = {
        audioBase64: bytesToBase64(clip.bytes),
        mimeType: clip.mimeType,
        ...(language ? { language } : {}),
      };

      if (transcribeLocal) {
        const content = await transcribeLocal(args);
        return { ...content, via: 'local' };
      }

      const target = findAsrPeer();
      if (!target) {
        throw new Error(
          "no ASR peer available: enable this peer's ASR host, or wait for a remote peer advertising asr.transcribe",
        );
      }
      const result = await callTool(target.peerId, ASR_TOOL_NAME, args as unknown as Record<string, unknown>);
      if (result.status !== 'ok') {
        throw new Error(result.error ?? `transcribe call ${result.status}`);
      }
      const content = (result.result as { content?: AsrTranscribeContent } | undefined)?.content;
      if (!content) {
        throw new Error('transcribe call returned no content');
      }
      return { ...content, via: target.peerId };
    },
    [callTool, findAsrPeer, transcribeLocal],
  );

  return { transcribe };
}
