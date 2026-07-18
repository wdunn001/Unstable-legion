/**
 * Wire-dtype A/B token-exactness — proves the `?wireDtype=f16` route
 * (see chatModelSource.ts, App.tsx, docs/WIRE-DTYPE.md) is safe to ship:
 * decode is greedy end-to-end (sampling=nullptr in the native stage), so a
 * fixed prompt run against a fixed model is deterministic per
 * configuration — any divergence between the f32 (lossless) and f16
 * (lossy-but-bounded) wire routes is a REAL signal, not test flake.
 *
 * Uses a SOLO self-hosting tab (`?testModel=1` + `acceptHosting` in the
 * SAME tab that then drives its own chat) rather than the multi-context
 * mesh product.spec.ts drives: the small qwen3-0.6b test model's ~26
 * communal layers (STAGE_TOTAL_LAYERS - STAGE_DRIVER_LAYERS, ~22MB/layer)
 * comfortably fit one browser tab's WebGPU weight budget, so one tab can
 * claim 100% of the remaining coverage and chat with itself — this
 * exercises the FULL encode/decode path (driver's `sendStageFrame` ->
 * Trystero `sf` self-loopback, see peer.ts's self-addressed-send doc
 * comment -> `useStageHost`'s `onStageFrame` decode -> native prefill/
 * decode -> `stage.token` back to the same tab's driver) without needing
 * 3+ separate browser contexts per run — important here since the full A/B
 * is 2 dtypes x 5 prompts = 10 complete generations.
 *
 * This suite ASSERTS the runs complete (every prompt reaches `finished`
 * with a non-empty token stream) — it does NOT hard-fail on divergence.
 * Per-prompt exactness/first-divergence-index is logged for the report;
 * whether f16 is safe to default to is a product/precision judgment call,
 * not something a single e2e run should gate CI on.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  acceptHosting,
  joinChat,
  sendChatMessage,
  waitForCapacityReady,
  waitForChatFinished,
  waitForHostingActive,
  wirePageLogging,
  type ChatDebugSnapshot,
} from './helpers.js';

const GATE_TIMEOUT_MS = 40 * 60 * 1000;

// Five prompts of deliberately varying length/shape — short, arithmetic,
// a ~50-word paragraph question, a code question, and a longer
// multi-part prompt (see the workstream brief's exact list).
const PROMPTS: readonly string[] = [
  'hello',
  'what is 2+2?',
  'In two or three sentences, describe what makes a good cup of coffee, ' +
    'touching on bean freshness, water temperature, and brew time — and ' +
    'mention one common mistake people make when brewing at home that ' +
    'ruins an otherwise good batch of beans.',
  'Write a JavaScript function that returns the nth Fibonacci number using memoization.',
  'We are planning a small team offsite next month. First, list three ' +
    'icebreaker activities suitable for a group of eight software ' +
    'engineers. Then, suggest a simple half-day agenda with time blocks. ' +
    'Finally, recommend one lightweight way to gather feedback afterward.',
];

interface PromptRun {
  prompt: string;
  tokens: number[];
}

/** Run every prompt in `PROMPTS` against an already-joined, already-hosting
 * solo tab, one fresh conversation thread per prompt (`.conversation-new`
 * — avoids multi-turn history differences confounding the exactness
 * comparison) — capturing the raw generated token-id sequence
 * (`chatTokens`, see App.tsx's `__legionChat` debug surface) for each. */
async function runPromptSet(page: Page, label: string): Promise<PromptRun[]> {
  const runs: PromptRun[] = [];
  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i]!;
    if (i > 0) {
      await page.locator('.conversation-new').click();
    }
    await sendChatMessage(page, prompt);
    const snap: ChatDebugSnapshot = await waitForChatFinished(page, `${label}-prompt${i}`, 8 * 60_000);
    const tokens = snap.chatTokens ?? [];
    console.log(`[wire-dtype] ${label} prompt${i} (${prompt.length} chars) -> ${tokens.length} tokens`);
    runs.push({ prompt, tokens });
  }
  return runs;
}

test('wire-dtype A/B: f32 (control) vs f16 token exactness across 5 prompts', async ({ context }) => {
  test.setTimeout(GATE_TIMEOUT_MS);
  const browser = context.browser();
  if (!browser) throw new Error('requires a browser-backed context');

  async function runDtype(dtype: 'f32' | 'f16'): Promise<PromptRun[]> {
    const room = `chat-wiredtype-${dtype}-${Date.now().toString(36)}`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    wirePageLogging(page, `solo-${dtype}`);
    await joinChat(page, room, `solo-${dtype}`, `&wireDtype=${dtype}`);
    await acceptHosting(page);
    await waitForHostingActive(page, 8 * 60_000);
    await waitForCapacityReady(page, 3 * 60_000);
    console.log(`[wire-dtype] ${dtype}: solo tab self-hosting, capacity ready`);
    const runs = await runPromptSet(page, dtype);
    await page.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    return runs;
  }

  const f32Runs = await runDtype('f32');
  const f16Runs = await runDtype('f16');

  // ── Report: per-prompt token-exact vs first-divergence index ─────────
  let anyDiverged = false;
  for (let i = 0; i < PROMPTS.length; i++) {
    const a = f32Runs[i]!.tokens;
    const b = f16Runs[i]!.tokens;
    const minLen = Math.min(a.length, b.length);
    let divergeAt = -1;
    for (let j = 0; j < minLen; j++) {
      if (a[j] !== b[j]) {
        divergeAt = j;
        break;
      }
    }
    if (divergeAt === -1 && a.length !== b.length) divergeAt = minLen;

    const promptPreview = PROMPTS[i]!.slice(0, 48).replace(/\s+/g, ' ');
    if (divergeAt === -1) {
      console.log(`[wire-dtype] RESULT prompt${i} "${promptPreview}…": TOKEN-EXACT (${a.length} tokens, f32 len=${a.length} f16 len=${b.length})`);
    } else {
      anyDiverged = true;
      console.log(
        `[wire-dtype] RESULT prompt${i} "${promptPreview}…": DIVERGED at token index ${divergeAt} ` +
          `(f32 len=${a.length}, f16 len=${b.length}, f32[${divergeAt}]=${a[divergeAt]}, f16[${divergeAt}]=${b[divergeAt]})`,
      );
    }

    // The suite asserts COMPLETION, not exactness — every prompt must
    // produce a real, non-empty generation on both routes.
    expect(a.length, `f32 run for prompt${i} produced no tokens`).toBeGreaterThan(0);
    expect(b.length, `f16 run for prompt${i} produced no tokens`).toBeGreaterThan(0);
  }
  console.log(`[wire-dtype] SUMMARY: ${anyDiverged ? 'at least one prompt diverged between f32 and f16 — see RESULT lines above' : 'all 5 prompts token-exact between f32 and f16'}`);
});

/**
 * i8 quality gate — the int8 activation wire (activationWireI8.ts) is a
 * LOSSY per-token abs-max quantization, so unlike f16 it is NOT expected to
 * be token-exact. Transformer hidden states carry massive-activation outlier
 * channels that dominate a per-row abs-max and can crush the remaining dims'
 * int8 resolution; whether that measurably harms greedy decode is exactly
 * what this A/B measures on a REAL model (not the synthetic unit tests). We
 * assert COMPLETION (i8 must produce a real generation) and report, per
 * prompt, the first-divergence index + how far into the sequence i8 tracks
 * f32 — a high divergence index (i8 matches f32 for many tokens before, if
 * ever, drifting) is the signal that i8 is safe to default to. NOTE: this
 * runs the 0.6b test model; the production 8B's outlier statistics differ,
 * so a clean result here is necessary-but-not-sufficient — final 8B sign-off
 * is a live `?wireDtype=f32` A/B on the real deployment.
 */
test('wire-dtype quality: f32 (control) vs i8 divergence across 5 prompts', async ({ context }) => {
  test.setTimeout(GATE_TIMEOUT_MS);
  const browser = context.browser();
  if (!browser) throw new Error('requires a browser-backed context');

  async function runDtype(dtype: 'f32' | 'i8'): Promise<PromptRun[]> {
    const room = `chat-wiredtype-${dtype}-${Date.now().toString(36)}`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    wirePageLogging(page, `solo-${dtype}`);
    await joinChat(page, room, `solo-${dtype}`, `&wireDtype=${dtype}`);
    await acceptHosting(page);
    await waitForHostingActive(page, 8 * 60_000);
    await waitForCapacityReady(page, 3 * 60_000);
    console.log(`[wire-dtype] ${dtype}: solo tab self-hosting, capacity ready`);
    const runs = await runPromptSet(page, dtype);
    await page.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    return runs;
  }

  const f32Runs = await runDtype('f32');
  const i8Runs = await runDtype('i8');

  let exactCount = 0;
  const divergeIndices: number[] = [];
  for (let i = 0; i < PROMPTS.length; i++) {
    const a = f32Runs[i]!.tokens;
    const b = i8Runs[i]!.tokens;
    const minLen = Math.min(a.length, b.length);
    let divergeAt = -1;
    for (let j = 0; j < minLen; j++) {
      if (a[j] !== b[j]) {
        divergeAt = j;
        break;
      }
    }
    if (divergeAt === -1 && a.length !== b.length) divergeAt = minLen;

    const promptPreview = PROMPTS[i]!.slice(0, 48).replace(/\s+/g, ' ');
    if (divergeAt === -1) {
      exactCount++;
      console.log(`[wire-dtype] i8 RESULT prompt${i} "${promptPreview}…": TOKEN-EXACT (${a.length} tokens)`);
    } else {
      divergeIndices.push(divergeAt);
      const pct = a.length > 0 ? ((divergeAt / a.length) * 100).toFixed(0) : '0';
      console.log(
        `[wire-dtype] i8 RESULT prompt${i} "${promptPreview}…": diverges at token ${divergeAt}/${a.length} (${pct}% in) ` +
          `(f32 len=${a.length}, i8 len=${b.length}, f32[${divergeAt}]=${a[divergeAt]}, i8[${divergeAt}]=${b[divergeAt]})`,
      );
    }

    expect(a.length, `f32 run for prompt${i} produced no tokens`).toBeGreaterThan(0);
    expect(b.length, `i8 run for prompt${i} produced no tokens`).toBeGreaterThan(0);
  }
  const avgDiverge = divergeIndices.length ? (divergeIndices.reduce((s, v) => s + v, 0) / divergeIndices.length).toFixed(1) : 'n/a';
  console.log(
    `[wire-dtype] i8 SUMMARY: ${exactCount}/${PROMPTS.length} token-exact vs f32; ` +
      `of the ${divergeIndices.length} that diverged, mean first-divergence token index = ${avgDiverge}. ` +
      'Read the RESULT lines above with the generated text to judge coherence — token divergence alone is expected for a lossy wire.',
  );
});
