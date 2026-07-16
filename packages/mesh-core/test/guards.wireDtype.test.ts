/**
 * Regression: a stage-hosting peer on a bundle that predates the f16-wire
 * `wireDtype` field omits it from its advertised `loadedStages` entry (and
 * JSON drops an `undefined` key). The cap guard must NOT reject such a peer
 * over a missing optional descriptor — otherwise any version skew silently
 * drops an otherwise-capable host from the mesh. Absent => f16 at ingestion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isMeshPeerCap } from '../src/guards.ts';
import { collectCommunalAds } from '../src/communalTopology.ts';
import type { MeshRosterEntry } from '../src/types.ts';

// A real capable-host cap (values from a live rejected peer) with the
// `loadedStages[0].wireDtype` field ABSENT.
function capWithoutWireDtype(): unknown {
  return {
    v: 1,
    ts: 1784228483798,
    nick: 'seiggy',
    modelId: 'qwen3-8b-q4',
    available: true,
    skills: [],
    systemPromptSummary: 'Unstable Legion communal chat client',
    tools: [],
    stageHost: {
      vramBytes: 17_664_000_000,
      failureDomainId: 'fd-test',
      maxStorageBufferBytes: 2_147_483_644,
      wasmHeapBudget: 1_600_000_000,
      maxSessions: 4,
      activeSessions: 0,
      loadedStages: [
        {
          modelId: 'qwen3-8b-q4',
          layerStart: 13,
          layerEnd: 29,
          includeEmbeddings: false,
          includeOutput: false,
          ctxSize: 4096,
          // wireDtype intentionally absent
          maxSessions: 4,
          activeSessions: 0,
          epoch: 1,
        },
      ],
      stability: { keepalive: false, visible: false, uptimeMs: 183_014, onBattery: false },
    },
  };
}

test('isMeshPeerCap: accepts a stage host whose loadedStages entry omits wireDtype', () => {
  assert.equal(isMeshPeerCap(capWithoutWireDtype()), true);
});

test('isMeshPeerCap: still rejects a loadedStages entry with a bad wireDtype value', () => {
  const cap = capWithoutWireDtype() as { stageHost: { loadedStages: Record<string, unknown>[] } };
  cap.stageHost.loadedStages[0].wireDtype = 'int4';
  assert.equal(isMeshPeerCap(cap), false);
});

test('collectCommunalAds: a dtype-less loadedStage is surfaced with wireDtype defaulted to f16', () => {
  const cap = capWithoutWireDtype();
  assert.equal(isMeshPeerCap(cap), true);
  const entry = { ...(cap as object), peerId: 'p-seiggy', lastSeen: Date.now() } as MeshRosterEntry;
  // communalStart=0 keeps a [13,29) ad; totalLayers must exceed layerEnd.
  const ads = collectCommunalAds([entry], 'qwen3-8b-q4', 36, 0);
  assert.equal(ads.length, 1);
  assert.equal(ads[0].wireDtype, 'f16');
});
