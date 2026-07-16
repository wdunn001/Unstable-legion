/**
 * GPU catalog matcher — turns a detected WebGPU/WebGL renderer string (or
 * a user's own free-text GPU name) into a VRAM estimate for the
 * "Contribute more" panel's pre-selected default.
 *
 * HARD RULE (standing user policy — device identity is dynamic/data-driven,
 * never a compile-time enum): `data/gpuCatalog.json` is a small, editable
 * DATA file, not a TypeScript union type. Nothing in this module (or any
 * caller) switches on a closed set of GPU name literals — the catalog is
 * consulted for a BEST-EFFORT pre-fill only, and free-text / a manual GB
 * number are first-class, always-available inputs regardless of whether a
 * match is found (a DIY build, an unlisted card, or a future GPU this
 * catalog hasn't been updated for all work identically to a listed one —
 * just without a pre-filled number).
 */
import gpuCatalogData from './data/gpuCatalog.json' with { type: 'json' };

export interface GpuCatalogEntry {
  /** Substring to match against a renderer/device string, case-insensitive. */
  match: string;
  /** Canonical display name shown in the searchable select. */
  name: string;
  /** Typical VRAM for this card, bytes. */
  vramBytes: number;
}

export const GPU_CATALOG: readonly GpuCatalogEntry[] = gpuCatalogData as GpuCatalogEntry[];

/**
 * Best catalog entry for a free-text renderer/GPU name string —
 * case-insensitive substring match; when multiple entries match (e.g. a
 * renderer string containing "RTX 4070 Ti" trivially also contains the
 * substring "RTX 4070"), the LONGEST `match` wins as the more specific
 * hit. Returns `undefined` when nothing matches — the caller's free-text
 * path is exactly as valid a result as a hit (see module doc's HARD RULE).
 */
export function matchGpuCatalog(rendererOrName: string | undefined | null): GpuCatalogEntry | undefined {
  if (!rendererOrName) return undefined;
  const haystack = rendererOrName.toLowerCase();
  let best: GpuCatalogEntry | undefined;
  for (const entry of GPU_CATALOG) {
    if (haystack.includes(entry.match.toLowerCase())) {
      if (!best || entry.match.length > best.match.length) best = entry;
    }
  }
  return best;
}

/** Exact lookup by the catalog's own `name` — for a searchable select
 * control resolving the user's chosen option back to its `vramBytes`. */
export function findGpuCatalogEntryByName(name: string): GpuCatalogEntry | undefined {
  return GPU_CATALOG.find((e) => e.name === name);
}

/** "24 GB" / "1.5 GB" — matches `approxDownloadLabel`'s (App.tsx) decimal-GB
 * convention (this codebase's `*Bytes` constants are all decimal, not
 * binary, throughout — see `CONTRIBUTION_BUDGET_CEILING_BYTES` etc.). */
export function formatVramLabel(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  return `${gb % 1 === 0 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

/** Inverse of `formatVramLabel` for the manual "type a GB number" input —
 * returns `undefined` for empty/non-numeric/non-positive input rather
 * than throwing, so the UI can leave the field simply unaccepted. */
export function parseGbInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 1_000_000_000);
}
