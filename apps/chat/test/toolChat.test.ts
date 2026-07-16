import test from 'node:test';
import assert from 'node:assert/strict';
import type { MeshRosterEntry } from '@unstable-legion/core';
import { buildToolResponsePayload, collectMeshTools, stripToolMarkup, MAX_TOOL_ROUNDS } from '../src/toolChat.ts';

function rosterEntry(peerId: string, toolNames: string[], available = true): MeshRosterEntry {
  return {
    peerId,
    nick: peerId,
    modelId: 'qwen3-8b-q4',
    available,
    skills: [],
    systemPromptSummary: '',
    tools: toolNames.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object' } })),
    lastSeen: Date.now(),
  } as unknown as MeshRosterEntry;
}

test('collectMeshTools: unions across peers, dedupes by name, keeps self', () => {
  const roster = [
    rosterEntry('self', ['current_time']),
    rosterEntry('peer-a', ['current_time', 'fetch_text']),
    rosterEntry('peer-b', ['ping']),
  ];
  const tools = collectMeshTools(roster);
  assert.deepEqual(tools.map((t) => t.name).sort(), ['current_time', 'fetch_text', 'ping']);
});

test('collectMeshTools: unavailable peers are excluded', () => {
  const roster = [rosterEntry('peer-a', ['ping'], false)];
  assert.equal(collectMeshTools(roster).length, 0);
});

test('buildToolResponsePayload: ok result -> bare content JSON', () => {
  const payload = buildToolResponsePayload('current_time', {
    status: 'ok',
    result: { content: { iso: '2026-07-16T12:00:00Z' } },
  });
  assert.equal(payload, '{"iso":"2026-07-16T12:00:00Z"}');
});

test('buildToolResponsePayload: failure -> {"error": ...} the model can read', () => {
  const payload = buildToolResponsePayload('fetch_text', { status: 'error', error: 'CORS blocked' });
  assert.deepEqual(JSON.parse(payload), { error: 'fetch_text: CORS blocked' });
});

test('buildToolResponsePayload: no result at all -> caller-supplied reason', () => {
  const payload = buildToolResponsePayload('ping', undefined, 'no provider');
  assert.deepEqual(JSON.parse(payload), { error: 'ping: no provider' });
});

test('stripToolMarkup: removes complete and dangling tool_call blocks', () => {
  const text = 'Let me check.\n<tool_call>\n{"name":"current_time","arguments":{}}\n</tool_call>\n';
  assert.equal(stripToolMarkup(text), 'Let me check.');
  assert.equal(stripToolMarkup('Sure.\n<tool_call>\n{"name":'), 'Sure.');
  assert.equal(stripToolMarkup('plain answer'), 'plain answer');
});

test('MAX_TOOL_ROUNDS bounds the loop', () => {
  assert.ok(Number.isInteger(MAX_TOOL_ROUNDS) && MAX_TOOL_ROUNDS >= 1 && MAX_TOOL_ROUNDS <= 5);
});
