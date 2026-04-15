import { PartEditorPanel } from './part-editor-panel';
import type { TestPart, TestSkill } from '../types';

interface ReviewEditorPaneProps {
  parts: TestPart[];
  skill: TestSkill | null;
}

export function ReviewEditorPane({ parts, skill }: ReviewEditorPaneProps) {
  return (
    <div className="review-pane-card">
      <div className="review-pane-head">
        <h3 className="review-pane-title">Review & Edit</h3>
        <p className="review-pane-subtitle">
          AI pre-fill is editable. Use Change Question Type to recover from classification mistakes while preserving question text.
        </p>
      </div>

      {parts.length === 0 ? (
        <div className="review-pane-empty">
          Extraction results will appear here.
        </div>
      ) : null}

      <div className="review-pane-stack">
        {parts.map((part, partIndex) => (
          <PartEditorPanel key={`part-${partIndex}`} part={part} partIndex={partIndex} skill={skill} />
        ))}
      </div>
    </div>
  );
}
