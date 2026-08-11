/**
 * useTtsClient — ask for synthesized speech, locally or over the mesh.
 * Mirrors `useSpeechClient.ts` exactly, just in the opposite direction
 * (text in, audio content out instead of audio in, text out).
 *
 * Resolves a target in priority order:
 *   1. This peer's own TTS host (`opts.synthesizeLocal`, if provided) —
 *      no mesh round-trip, solo mode included.
 *   2. The first roster peer (via `useMeshRoster()`) advertising
 *      `TTS_SKILL` in `skills[]`, via `callTool(peerId, TTS_TOOL_NAME, args)`.
 * Throws a clear error if neither is available. The resolved content
 * carries an extra `via` field (`'local'` or the serving peer's id) so a
 * UI can show which path served the request — a strict superset of
 * `TtsSynthesizeContent`, so it's still assignable wherever the bare
 * contract type is expected.
 */
import { useCallback, useMemo } from 'react';
import {
  TTS_SKILL,
  TTS_TOOL_NAME,
  type TtsSynthesizeArgs,
  type TtsSynthesizeContent,
} from '@unstable-legion/core';

import { useMeshContext } from './provider.js';
import { useMeshRoster } from './useMeshRoster.js';
import type { CallToolFn } from './useSpeechClient.js';

export interface UseTtsClientOptions {
  /** `useMeshTools().callTool` — used when no local TTS host is available. */
  callTool: CallToolFn;
  /** `useTtsHost().synthesizeLocal`, when this peer hosts TTS itself. Omit/undefined = always route to a remote peer. */
  synthesizeLocal?: (args: TtsSynthesizeArgs) => Promise<TtsSynthesizeContent>;
}

export type TtsSynthesizeContentWithSource = TtsSynthesizeContent & { via: 'local' | string };

export interface UseTtsClientHandle {
  synthesize: (text: string, opts?: { voice?: string; speed?: number }) => Promise<TtsSynthesizeContentWithSource>;
}

export function useTtsClient(opts: UseTtsClientOptions): UseTtsClientHandle {
  const { callTool, synthesizeLocal } = opts;
  const { peer } = useMeshContext();
  const roster = useMeshRoster();

  const findTtsPeer = useMemo(
    () => () => roster.find((r) => r.peerId !== peer?.selfId && r.skills.includes(TTS_SKILL)),
    [roster, peer],
  );

  const synthesize = useCallback(
    async (text: string, options?: { voice?: string; speed?: number }): Promise<TtsSynthesizeContentWithSource> => {
      const args: TtsSynthesizeArgs = {
        text,
        ...(options?.voice ? { voice: options.voice } : {}),
        ...(options?.speed !== undefined ? { speed: options.speed } : {}),
      };

      if (synthesizeLocal) {
        const content = await synthesizeLocal(args);
        return { ...content, via: 'local' };
      }

      const target = findTtsPeer();
      if (!target) {
        throw new Error(
          "no TTS peer available: enable this peer's TTS host, or wait for a remote peer advertising tts.synthesize",
        );
      }
      const result = await callTool(target.peerId, TTS_TOOL_NAME, args as unknown as Record<string, unknown>);
      if (result.status !== 'ok') {
        throw new Error(result.error ?? `synthesize call ${result.status}`);
      }
      const content = (result.result as { content?: TtsSynthesizeContent } | undefined)?.content;
      if (!content) {
        throw new Error('synthesize call returned no content');
      }
      return { ...content, via: target.peerId };
    },
    [callTool, findTtsPeer, synthesizeLocal],
  );

  return { synthesize };
}
