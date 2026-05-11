/**
 * DirectorTrace — per-step inline trace for orchestrated calls.
 *
 * Renders a series of tool-call steps with their status, latency,
 * and a result snippet. Click a step to expand its full args + result.
 * Used by /skill, /ensemble, /maps, /director commands.
 *
 * Host styles via `ul-trace-*` semantic classes.
 */
import { useState } from 'react';

export interface DirectorTraceStep {
  /** Stable id for the step (e.g. callId or `${stepIndex}-${peerId}`). */
  id: string;
  /** Human label — what's being attempted. */
  label: string;
  /** Optional peer nick / id this step routes to. */
  target?: string | undefined;
  /** Status: 'running' | 'ok' | 'error' | 'denied'. */
  status: 'running' | 'ok' | 'error' | 'denied';
  /** ISO time the step started; used for latency display. */
  startedAt: number;
  /** ISO time the step finished; undefined while running. */
  finishedAt?: number | undefined;
  /** One-line summary shown collapsed. */
  summary?: string | undefined;
  /** Full args / result payload, shown when expanded. */
  detail?: unknown;
}

export interface DirectorTraceProps {
  /** Steps in execution order. */
  steps: readonly DirectorTraceStep[];
  /** Optional header shown above the step list (e.g. "/director" + prompt). */
  header?: string;
}

export function DirectorTrace(props: DirectorTraceProps) {
  if (props.steps.length === 0) return null;
  return (
    <div className="ul-trace">
      {props.header && <div className="ul-trace-header">{props.header}</div>}
      <ol className="ul-trace-steps">
        {props.steps.map((step) => (
          <TraceStep key={step.id} step={step} />
        ))}
      </ol>
    </div>
  );
}

function TraceStep({ step }: { step: DirectorTraceStep }) {
  const [open, setOpen] = useState(false);
  const latency =
    step.finishedAt !== undefined ? `${step.finishedAt - step.startedAt}ms` : '…';
  const cls = `ul-trace-step ul-trace-${step.status}`;
  return (
    <li className={cls}>
      <button
        type="button"
        className="ul-trace-row"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ul-trace-status">
          {step.status === 'running'
            ? '◌'
            : step.status === 'ok'
              ? '✓'
              : step.status === 'denied'
                ? '⊘'
                : '✗'}
        </span>
        <span className="ul-trace-label">{step.label}</span>
        {step.target && <span className="ul-muted">→ {step.target}</span>}
        <span className="ul-muted ul-trace-latency">{latency}</span>
      </button>
      {step.summary && !open && (
        <div className="ul-trace-summary ul-muted">{step.summary}</div>
      )}
      {open && step.detail !== undefined && (
        <pre className="ul-trace-detail">
          {safeStringify(step.detail)}
        </pre>
      )}
    </li>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
