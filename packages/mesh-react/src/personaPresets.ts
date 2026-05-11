/**
 * Persona role presets — one-click bundles that fill skills,
 * authoritative zones, delegating zones, and suggested-tool opt-ins.
 *
 * The point: most operators don't know what dotted skill paths to
 * invent. Presets give them a curated, useful-to-the-mesh starting
 * point. After clicking a preset they can still edit the raw fields
 * in the advanced panel.
 *
 * Each preset corresponds to a realistic mesh role:
 *   - thin-client devices (Adreno mobile) → tool-host
 *   - small-model browsers → generalist / translator / coder
 *   - mid-model browsers → function-caller / reasoner
 *   - desktop / server-bridge → coordinator / specialist
 */

export interface PersonaPreset {
  id: string;
  label: string;
  /** One-line description shown under the button. */
  description: string;
  /** Best-fit model family (informational; persona keeps its own modelId). */
  bestModelHint?: string;
  /** Default `skills[]` for back-compat consumers + the aggregated public-tools view. */
  skills: readonly string[];
  /**
   * Layer-4 authoritative skills — dotted paths the peer will execute
   * (via `engine_run` for LLM-shaped work, or a named tool).
   */
  authoritative: readonly string[];
  /**
   * Layer-4 delegating zones — DNS-NS-style routing. Empty for pure
   * specialists; non-empty for coordinators / routers.
   */
  delegating: readonly string[];
  /**
   * Suggested local tools to opt in. These get added to the
   * persona's `availableTools` on top of whatever was there.
   */
  suggestedTools: readonly string[];
  /** Brief paragraph explaining what this role contributes. */
  rationale: string;
}

export const PERSONA_PRESETS: readonly PersonaPreset[] = [
  {
    id: 'thinclient-tool-host',
    label: 'Tool host',
    description: "Can't run a model — contributes tools, MCP endpoints, and pure-JS work to the mesh.",
    bestModelHint: 'no model needed',
    skills: ['tool-host'],
    authoritative: [],
    delegating: [],
    suggestedTools: ['current_time', 'fetch_text', 'ping'],
    rationale:
      "Pick this on devices that can't host an LLM (Adreno mobile, no-WebGPU browsers). You still tokenize/detokenize, host built-in + MCP tools, and forward /skill calls to peers that can run a model. First-class participant, just not an inference node.",
  },
  {
    id: 'generalist-chat',
    label: 'Generalist chat',
    description: 'Plain chat, summarization, Q&A. Works on any small/medium model.',
    bestModelHint: 'Qwen2.5-0.5B / Llama-3.2-1B / SmolLM2-360M',
    skills: ['chat', 'summarize', 'qa'],
    authoritative: ['chat', 'summarize', 'qa', 'language.en'],
    delegating: [],
    suggestedTools: ['current_time', 'ping'],
    rationale:
      'The default. Answer general questions, summarize text, do basic Q&A. Any of the small models in the catalog can fill this role — pick whichever your device can run.',
  },
  {
    id: 'code-helper',
    label: 'Code helper',
    description: 'Code review, debug, completion. Strongest with Qwen2.5-Coder.',
    bestModelHint: 'Qwen2.5-Coder-1.5B',
    skills: ['coding', 'code-review', 'debugging'],
    authoritative: [
      'coding',
      'coding.review',
      'coding.debug',
      'coding.completion',
    ],
    delegating: [],
    suggestedTools: ['fetch_text', 'ping'],
    rationale:
      'Inspect code, suggest fixes, explain stack traces, write small functions. Coder-1.5B is fine-tuned for this; generalist models work in a pinch.',
  },
  {
    id: 'translator-ja',
    label: 'Japanese translator',
    description: 'Japanese ↔ English translation. Best with Gemma-2-2B-JPN.',
    bestModelHint: 'Gemma-2-2B-JPN',
    skills: ['ja-translate', 'translate'],
    authoritative: [
      'language.ja',
      'language.ja.translate',
      'language.ja.en',
      'language.en.ja',
    ],
    delegating: [],
    suggestedTools: ['ping'],
    rationale:
      'Dedicated Japanese-language specialist. Other peers route here when they need to translate, summarize, or rewrite anything in Japanese.',
  },
  {
    id: 'function-caller',
    label: 'Function-calling agent',
    description: 'Tool-using orchestrator. Best with Hermes-3-Llama-3B.',
    bestModelHint: 'Hermes-3-Llama-3.2-3B',
    skills: ['function-calling', 'agent', 'tool-use'],
    authoritative: ['agent', 'orchestrate'],
    delegating: ['research', 'coding', 'language'],
    suggestedTools: ['current_time', 'fetch_text', 'route_skill', 'ping'],
    rationale:
      'The director-mode model. Receives a complex prompt, plans, emits <tool_call> blocks the mesh dispatches. Also routes for research/coding/language zones so it can find specialists when needed.',
  },
  {
    id: 'reasoner',
    label: 'Reasoning specialist',
    description: 'Chain-of-thought, math, careful explanations. Best with Phi-3.5.',
    bestModelHint: 'Phi-3.5-mini',
    skills: ['reasoning', 'math', 'qa'],
    authoritative: [
      'reasoning',
      'reasoning.math',
      'reasoning.proofs',
      'reasoning.explain',
    ],
    delegating: [],
    suggestedTools: ['ping'],
    rationale:
      "When you need a thoughtful answer with shown work. Phi-3.5 punches above its size on reasoning benchmarks. Don't pair this with a tiny model.",
  },
  {
    id: 'researcher',
    label: 'Researcher / RAG',
    description: 'Web fetch + summarize + cite. Pair with MCP search tools.',
    bestModelHint: 'Llama-3.2-1B + fetch_text + MCP search',
    skills: ['research', 'summarize'],
    authoritative: [
      'research',
      'research.web',
      'research.summarize',
      'research.cite',
    ],
    delegating: [],
    suggestedTools: ['fetch_text', 'current_time', 'ping'],
    rationale:
      "Browse URLs, gather context, summarize with citations. The fetch_text tool's CORS limits mean some sites won't work — pair an MCP search endpoint from the public registry for a richer surface.",
  },
  {
    id: 'coordinator',
    label: 'Coordinator (DNS router)',
    description: "Doesn't host a model — routes skill queries to specialist peers.",
    bestModelHint: 'no model needed (or any small one for fallback)',
    skills: ['router'],
    authoritative: [],
    delegating: ['language', 'coding', 'research', 'reasoning'],
    suggestedTools: ['route_skill', 'current_time', 'ping'],
    rationale:
      "A mid-tier routing node, DNS-style. Doesn't execute skills itself — forwards them to peers that do. Lets the mesh scale past what any single director can hold in context: directors call coordinators; coordinators call specialists.",
  },
];

/** Find a preset by id. */
export function findPersonaPreset(id: string): PersonaPreset | undefined {
  return PERSONA_PRESETS.find((p) => p.id === id);
}
