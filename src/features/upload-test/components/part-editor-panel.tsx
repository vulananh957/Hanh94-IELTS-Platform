'use client';

import { useState } from 'react';
import { QuestionTypeBlock } from './question-type-block';
import {
  LEGACY_LISTENING_QUESTION_TYPES,
  LEGACY_QUESTION_TYPES,
  LEGACY_READING_QUESTION_TYPES,
  type LegacyQuestionType,
  type TestPart,
  type TestSkill,
} from '../types';
import { useUploadTestStore } from '../store/use-upload-test-store';

interface PartEditorPanelProps {
  part: TestPart;
  partIndex: number;
  skill: TestSkill | null;
}

function getOptionsBySkill(skill: TestSkill | null): readonly LegacyQuestionType[] {
  if (skill === 'reading') return LEGACY_READING_QUESTION_TYPES;
  if (skill === 'listening') return LEGACY_LISTENING_QUESTION_TYPES;
  return Array.from(new Set(LEGACY_QUESTION_TYPES)) as readonly LegacyQuestionType[];
}

export function PartEditorPanel({ part, partIndex, skill }: PartEditorPanelProps) {
  const addQuestionType = useUploadTestStore((state) => state.addQuestionType);
  const [pendingType, setPendingType] = useState<LegacyQuestionType>(
    getOptionsBySkill(skill)[0] as LegacyQuestionType,
  );

  const options = getOptionsBySkill(skill);

  return (
    <section className="review-part-card">
      <header className="review-part-head">
        <div className="review-part-intro">
          <p className="review-kicker">Part {partIndex + 1}</p>
          <h2 className="review-part-title">{part.name || `Part ${partIndex + 1}`}</h2>
          <p className="review-part-meta">{part.questionTypes.length} question groups in this part</p>
        </div>

        <div className="review-part-actions">
          <label className="review-control">
            <span className="review-control-label">Add New Group</span>
            <select
              value={pendingType}
              onChange={(event) => setPendingType(event.target.value as LegacyQuestionType)}
              className="review-control-input"
            >
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => addQuestionType(partIndex, pendingType)}
            className="review-action-btn review-action-btn-primary"
          >
            Add Question Group
          </button>
        </div>
      </header>

      <div className="review-type-stack">
        {part.questionTypes.length === 0 ? (
          <div className="review-empty-block">
            No question groups yet. Add one from the selector above.
          </div>
        ) : null}

        {part.questionTypes.map((questionType, questionTypeIndex) => (
          <QuestionTypeBlock
            key={`part-${partIndex}-qt-${questionTypeIndex}`}
            partIndex={partIndex}
            questionTypeIndex={questionTypeIndex}
            questionType={questionType}
            skill={skill}
          />
        ))}
      </div>
    </section>
  );
}
