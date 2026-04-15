import {
  LEGACY_LISTENING_QUESTION_TYPES,
  LEGACY_QUESTION_TYPES,
  LEGACY_READING_QUESTION_TYPES,
  type LegacyQuestionType,
  type TestSkill,
} from '../types';

interface FallbackQuestionTypeSelectProps {
  skill: TestSkill | null;
  value: LegacyQuestionType;
  onChange: (nextType: LegacyQuestionType) => void;
}

function getOptions(skill: TestSkill | null): readonly LegacyQuestionType[] {
  if (skill === 'reading') return LEGACY_READING_QUESTION_TYPES;
  if (skill === 'listening') return LEGACY_LISTENING_QUESTION_TYPES;
  return Array.from(new Set(LEGACY_QUESTION_TYPES)) as readonly LegacyQuestionType[];
}

export function FallbackQuestionTypeSelect({
  skill,
  value,
  onChange,
}: FallbackQuestionTypeSelectProps) {
  const options = getOptions(skill);

  return (
    <label className="review-control review-control-tight">
      <span className="review-control-label">Change Question Type</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as LegacyQuestionType)}
        className="review-control-input review-control-input-compact"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
