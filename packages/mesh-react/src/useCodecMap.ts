/**
 * useCodecMap — fetch tokenizer maps from `.well-known/codec/` and
 * instantiate Detokenizers on demand.
 *
 * Edge detokenize only. The wire path between peers carries raw token
 * IDs; each peer that wants to *show* a response runs a `Detokenizer`
 * against the responding peer's model's tokenizer map.
 *
 * Two modes:
 *
 *   - `useCodecMap()` loads a single family (default `qwen/qwen2`).
 *     Eager fetch on mount.
 *   - `useCodecMapResolver()` returns a function that maps an
 *     advertised model id ("Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
 *     "Llama-3-8B", etc.) to a Detokenizer via the `aliases.json` →
 *     `index.json` chain. Caches loaded maps per family. Use this in
 *     the chat receiver path so frames from peers running different
 *     models render through their own family's vocab.
 */
import { useEffect, useMemo, useState } from 'react';
import { Detokenizer, loadMap, type TokenizerMap } from '@codecai/web';

interface Pointer {
  id: string;
  url: string;
  hash: string;
}
interface MapIndex {
  codec_version: string;
  maps: Pointer[];
}

const DEFAULT_INDEX_URL = '/.well-known/codec/index.json';
const DEFAULT_ALIASES_URL = '/.well-known/codec/aliases.json';
const DEFAULT_FAMILY = 'qwen/qwen2';

const REGEX_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Qwen2/i, 'qwen/qwen2'],
  [/^SmolLM2/i, 'huggingfacetb/smollm2'],
  [/^Hermes-3-Llama-3/i, 'meta-llama/llama-3'],
  [/^Llama-3/i, 'meta-llama/llama-3'],
  [/^Llama-2/i, 'meta-llama/llama-2'],
  [/^gemma-2/i, 'google/gemma-2'],
  [/^gemma/i, 'google/gemma-1'],
  [/^Phi-4/i, 'microsoft/phi-4'],
  [/^Phi-3/i, 'microsoft/phi-3'],
  [/^Mistral-Nemo/i, 'mistralai/mistral-nemo'],
  [/^Mistral/i, 'mistralai/mistral-v3'],
  [/^Mixtral/i, 'mistralai/mixtral'],
  [/^Codestral/i, 'mistralai/codestral'],
  [/^DeepSeek/i, 'deepseek-ai/deepseek-v3'],
  [/^falcon/i, 'tiiuae/falcon'],
  [/^claude/i, 'anthropic/claude-3-text'],
];

let indexPromise: Promise<MapIndex> | null = null;
async function fetchIndex(url: string): Promise<MapIndex> {
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) throw new Error(`well-known index: HTTP ${r.status}`);
    return (await r.json()) as MapIndex;
  })().catch((err) => {
    indexPromise = null;
    throw err;
  });
  return indexPromise;
}

let aliasesPromise: Promise<Record<string, string>> | null = null;
async function fetchAliases(url: string): Promise<Record<string, string>> {
  if (aliasesPromise) return aliasesPromise;
  aliasesPromise = (async () => {
    try {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) return {};
      return (await r.json()) as Record<string, string>;
    } catch {
      return {};
    }
  })();
  return aliasesPromise;
}

function familyForModelId(modelId: string, exactAliases: Record<string, string>): string {
  if (modelId in exactAliases) return exactAliases[modelId]!;
  const stripped = modelId.replace(/-q[0-9].*-MLC$/i, '').replace(/-MLC$/i, '');
  if (stripped !== modelId && stripped in exactAliases) return exactAliases[stripped]!;
  const tail = stripped.includes('/') ? stripped.split('/').pop()! : stripped;
  for (const [rx, fam] of REGEX_ALIASES) {
    if (rx.test(tail)) return fam;
  }
  return DEFAULT_FAMILY;
}

const familyMapCache = new Map<string, Promise<TokenizerMap>>();
function getFamilyMap(family: string, indexUrl: string): Promise<TokenizerMap> {
  const cached = familyMapCache.get(family);
  if (cached) return cached;
  const p = (async () => {
    const idx = await fetchIndex(indexUrl);
    const ptr = idx.maps.find((m) => m.id === family);
    if (!ptr) throw new Error(`no .well-known pointer for family "${family}"`);
    return await loadMap(ptr);
  })().catch((err) => {
    familyMapCache.delete(family);
    throw err;
  });
  familyMapCache.set(family, p);
  return p;
}

export interface UseCodecMapOptions {
  /** Codec-maps family id. Default `qwen/qwen2`. */
  family?: string;
  /** Override the index URL. Default `/.well-known/codec/index.json`. */
  indexUrl?: string;
}

export interface CodecMapHandle {
  map: TokenizerMap | null;
  error: string | null;
}

export function useCodecMap(opts: UseCodecMapOptions = {}): CodecMapHandle {
  const family = opts.family ?? DEFAULT_FAMILY;
  const indexUrl = opts.indexUrl ?? DEFAULT_INDEX_URL;
  const [map, setMap] = useState<TokenizerMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFamilyMap(family, indexUrl).then(
      (m) => {
        if (!cancelled) setMap(m);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [family, indexUrl]);

  return { map, error };
}

export interface UseCodecMapResolverOptions {
  indexUrl?: string;
  aliasesUrl?: string;
}

export interface CodecMapResolverHandle {
  detokenizerFor: (modelId: string) => Detokenizer | null;
}

export function useCodecMapResolver(
  opts: UseCodecMapResolverOptions = {},
): CodecMapResolverHandle {
  const indexUrl = opts.indexUrl ?? DEFAULT_INDEX_URL;
  const aliasesUrl = opts.aliasesUrl ?? DEFAULT_ALIASES_URL;
  const [version, setVersion] = useState(0);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [familyDetoks, setFamilyDetoks] = useState<Map<string, Detokenizer>>(
    () => new Map(),
  );

  useEffect(() => {
    void fetchAliases(aliasesUrl).then(setAliases);
  }, [aliasesUrl]);

  const detokenizerFor = useMemo(
    () => (modelId: string): Detokenizer | null => {
      const family = familyForModelId(modelId, aliases);
      const cached = familyDetoks.get(family);
      if (cached) return cached;
      void getFamilyMap(family, indexUrl).then((tm) => {
        setFamilyDetoks((prev) => {
          if (prev.has(family)) return prev;
          const next = new Map(prev);
          next.set(family, new Detokenizer(tm));
          return next;
        });
        setVersion((v) => v + 1);
      });
      return null;
    },
    [aliases, familyDetoks, indexUrl],
  );

  void version;
  return { detokenizerFor };
}
