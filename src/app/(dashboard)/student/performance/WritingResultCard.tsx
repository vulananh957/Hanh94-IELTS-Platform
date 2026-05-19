'use client';

import type { WritingResult } from '@/services/student-writing-results';

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function gradedByDisplay(raw?: string): string {
  if (!raw) return 'Unknown';
  if (raw.includes('vulananh957') || raw.includes('hanh')) return 'Ms. Hanh Le';
  return raw;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ScoreBadge({ score, pending }: { score: number | 'Pending'; pending: boolean }) {
  if (pending) {
    return <div className="wrc-score-badge pending">Pending</div>;
  }
  return (
    <div className="wrc-score-badge">
      <span className="wrc-score-number">{typeof score === 'number' ? score.toFixed(1) : '—'}</span>
      <span className="wrc-score-unit">Band</span>
    </div>
  );
}

function TaskChips({ t1, t2, pending }: { t1?: number; t2?: number; pending: boolean }) {
  return (
    <div className="wrc-task-chips">
      <span className="wrc-chip">T1: {pending ? '—' : (t1 != null ? t1 : '—')}</span>
      <span className="wrc-chip">T2: {pending ? '—' : (t2 != null ? t2 : '—')}</span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface WritingResultCardProps {
  result: WritingResult;
  index: number;         // display number (descending)
  onSelect: (result: WritingResult) => void;
}

export function WritingResultCard({ result, index, onSelect }: WritingResultCardProps) {
  const isPending = result.writingScore === 'Pending';
  const statusLabel = isPending ? 'Pending' : 'Graded';

  const feedbackSnippet = result.feedback
    ? result.feedback.trim()
    : result.feedbackFileUrl
      ? 'Detailed feedback provided via uploaded file.'
      : 'No feedback text available yet.';

  return (
    <div
      className={`wrc-card ${isPending ? 'wrc-card--pending' : ''}`}
      onClick={() => onSelect(result)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(result); }}
      aria-label={`View details for ${result.testName} #${index}`}
    >
      {/* Left: metadata */}
      <div className="wrc-card-body">
        <div className="wrc-card-top">
          <div className="wrc-title-group">
            <span className="wrc-index">#{index}</span>
            <h3 className="wrc-title">{result.testName}</h3>
            <span className={`wrc-status ${isPending ? 'pending' : 'graded'}`}>{statusLabel}</span>
          </div>
          <TaskChips t1={result.task1Score} t2={result.task2Score} pending={isPending} />
        </div>

        <div className="wrc-meta">
          <span>Submitted {formatDate(result.submittedAt)}</span>
          {!isPending && result.gradedAt && (
            <>
              <span className="wrc-meta-sep">·</span>
              <span>Graded {formatDate(result.gradedAt)}</span>
              <span className="wrc-meta-sep">·</span>
              <span>{gradedByDisplay(result.gradedBy)}</span>
            </>
          )}
        </div>

        <p className="wrc-snippet">{feedbackSnippet}</p>
      </div>

      {/* Right: score + CTA */}
      <div className="wrc-card-right">
        <ScoreBadge score={result.writingScore} pending={isPending} />
        <button
          type="button"
          className="wrc-cta"
          onClick={(e) => { e.stopPropagation(); onSelect(result); }}
        >
          View Details <i className="fas fa-arrow-right" />
        </button>
      </div>
    </div>
  );
}
