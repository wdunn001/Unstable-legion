/**
 * gpuCatalog.ts unit tests — the renderer-string -> catalog-entry matcher
 * backing the "Contribute more" panel's pre-selected default. Pure, no
 * DOM/WebGPU needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GPU_CATALOG, matchGpuCatalog, findGpuCatalogEntryByName, formatVramLabel, parseGbInput } from '../src/gpuCatalog.ts';

test('GPU_CATALOG: non-trivial, every entry well-formed, no duplicate names', () => {
  assert.ok(GPU_CATALOG.length >= 20, `expected a real catalog, got ${GPU_CATALOG.length} entries`);
  const names = new Set<string>();
  for (const entry of GPU_CATALOG) {
    assert.ok(entry.match.length > 0);
    assert.ok(entry.name.length > 0);
    assert.ok(Number.isFinite(entry.vramBytes) && entry.vramBytes > 0, `bad vramBytes for ${entry.name}`);
    assert.ok(!names.has(entry.name), `duplicate catalog name: ${entry.name}`);
    names.add(entry.name);
  }
});

test('matchGpuCatalog: known WebGL ANGLE renderer string -> matches the right card', () => {
  const renderer = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const match = matchGpuCatalog(renderer);
  assert.ok(match);
  assert.equal(match!.name, 'NVIDIA GeForce RTX 4090');
  assert.equal(match!.vramBytes, 24_000_000_000);
});

test('matchGpuCatalog: known WebGPU adapter description string -> matches', () => {
  const match = matchGpuCatalog('AMD Radeon RX 7900 XTX');
  assert.ok(match);
  assert.equal(match!.name, 'AMD Radeon RX 7900 XTX');
});

test('matchGpuCatalog: case-insensitive', () => {
  const match = matchGpuCatalog('nvidia geforce rtx 3080');
  assert.ok(match);
  assert.equal(match!.name, 'NVIDIA GeForce RTX 3080');
});

test('matchGpuCatalog: longest match wins on ambiguity (RTX 4070 Ti Super vs RTX 4070 Ti vs RTX 4070)', () => {
  assert.equal(matchGpuCatalog('... RTX 4070 Ti Super ...')!.name, 'NVIDIA GeForce RTX 4070 Ti Super');
  assert.equal(matchGpuCatalog('... RTX 4070 Ti ...')!.name, 'NVIDIA GeForce RTX 4070 Ti');
  assert.equal(matchGpuCatalog('... RTX 4070 ...')!.name, 'NVIDIA GeForce RTX 4070');
});

test('matchGpuCatalog: unknown/unlisted GPU -> undefined (free-text path is first-class, not an error)', () => {
  assert.equal(matchGpuCatalog('Totally Homebrew FPGA Accelerator 9000'), undefined);
  assert.equal(matchGpuCatalog(''), undefined);
  assert.equal(matchGpuCatalog(undefined), undefined);
  assert.equal(matchGpuCatalog(null), undefined);
});

test('findGpuCatalogEntryByName: exact name lookup for the searchable-select control', () => {
  const entry = findGpuCatalogEntryByName('Apple M3 Max');
  assert.ok(entry);
  assert.equal(entry!.vramBytes, 36_000_000_000);
  assert.equal(findGpuCatalogEntryByName('not a real gpu'), undefined);
});

test('formatVramLabel: whole GB has no decimal, fractional GB keeps one decimal', () => {
  assert.equal(formatVramLabel(24_000_000_000), '24 GB');
  assert.equal(formatVramLabel(1_500_000_000), '1.5 GB');
});

test('parseGbInput: valid numeric strings parse to bytes; empty/garbage/non-positive -> undefined', () => {
  assert.equal(parseGbInput('24'), 24_000_000_000);
  assert.equal(parseGbInput('1.5'), 1_500_000_000);
  assert.equal(parseGbInput('  8  '), 8_000_000_000);
  assert.equal(parseGbInput(''), undefined);
  assert.equal(parseGbInput('not a number'), undefined);
  assert.equal(parseGbInput('0'), undefined);
  assert.equal(parseGbInput('-5'), undefined);
});
