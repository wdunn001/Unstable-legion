/**
 * Ambient module declaration for `kokoro-js`.
 *
 * kokoro-js ships types only behind its package.json `exports` map (no
 * top-level `types`/`main` field), which classic `moduleResolution:
 * "Node"` — required for this package's `dist/cjs` build (see
 * `tsconfig.cjs.json`) — can't see (`exports` postdates that resolver).
 * The ESM build (`moduleResolution: "Bundler"`) resolves the real
 * package types fine; this ambient declaration exists so the CJS build
 * type-checks too, without changing that build's module resolution mode
 * (which TypeScript ties tightly to the `module` emit target). Kept
 * intentionally narrow — just the shape `kokoroEngine.ts` actually uses.
 */
declare module 'kokoro-js' {
  export class KokoroTTS {
    static from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<KokoroTTS>;
    generate(text: string, options?: { voice?: string }): Promise<{ audio: Float32Array; sampling_rate: number }>;
    list_voices(): string[];
  }
}
