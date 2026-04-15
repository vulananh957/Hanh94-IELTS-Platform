import { FallbackQuestionTypeSelect } from './fallback-question-type-select';
import { QuestionEditorRow } from './question-editor-row';
import { useFileInputWithDragDrop } from '../hooks/use-file-input-with-drag-drop';
import { useUploadTestStore } from '../store/use-upload-test-store';
import type { TestQuestionType, TestSkill } from '../types';

interface QuestionTypeBlockProps {
  partIndex: number;
  questionTypeIndex: number;
  questionType: TestQuestionType;
  skill: TestSkill | null;
}

export function QuestionTypeBlock({
  partIndex,
  questionTypeIndex,
  questionType,
  skill,
}: QuestionTypeBlockProps) {
  const changeQuestionType = useUploadTestStore((state) => state.changeQuestionType);
  const updateQuestionType = useUploadTestStore((state) => state.updateQuestionType);
  const addQuestion = useUploadTestStore((state) => state.addQuestion);
  const removeQuestionType = useUploadTestStore((state) => state.removeQuestionType);

  const isMatchingHeadings = /matching headings/i.test(questionType.type);
  const hasFeaturesList = /matching features|pick from a list|matching \(info\/features\/sentence halves\)/i.test(questionType.type);
  const hasSentenceEndingsList = /matching sentence endings/i.test(questionType.type);
  const hasSummaryBlock = /completion|form|diagram|flow\-chart|table|note|summary/i.test(questionType.type);
  const hasImageSupport = /form|diagram|flow\-chart|table|note|summary|map/i.test(questionType.type);

  // Drag-drop handler for image upload
  const imageDragDrop = useFileInputWithDragDrop({
    onFileSelect: onImageChange,
    acceptedTypes: ['image/*'],
  });

  function onImageChange(file: File | null) {
    if (!file) {
      updateQuestionType(partIndex, questionTypeIndex, { imageData: undefined });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl) return;

      updateQuestionType(partIndex, questionTypeIndex, {
        imageData: {
          src: dataUrl,
          name: file.name,
        },
      });
    };
    reader.readAsDataURL(file);
  }

  return (
    <article className="review-type-card">
      <header className="review-type-head">
        <div className="review-type-intro">
          <span className="review-chip">Question Group</span>
          <h3 className="review-type-title">{questionType.type}</h3>
          <p className="review-type-meta">
            {questionType.questionCount} questions | {questionType.startNumber ?? '-'} to {questionType.endNumber ?? '-'}
          </p>
        </div>

        <div className="review-type-actions">
          <FallbackQuestionTypeSelect
            skill={skill}
            value={questionType.type}
            onChange={(nextType) => changeQuestionType(partIndex, questionTypeIndex, nextType)}
          />
          <button
            type="button"
            onClick={() => removeQuestionType(partIndex, questionTypeIndex)}
            className="review-action-btn review-action-btn-danger"
          >
            Remove Group
          </button>
        </div>
      </header>

      <div className="review-type-config-grid">
        <label className="review-field review-field-wide">
          <span className="review-field-label">Instructions</span>
          <textarea
            value={questionType.instructions || ''}
            onChange={(event) =>
              updateQuestionType(partIndex, questionTypeIndex, {
                instructions: event.target.value,
              })
            }
            rows={2}
            className="review-textarea"
            placeholder="Optional instructions shown to students"
          />
        </label>

        {isMatchingHeadings ? (
          <label className="review-field review-field-wide">
            <span className="review-field-label">Headings List</span>
            <textarea
              value={questionType.headingsList || ''}
              onChange={(event) => {
                const headingsList = event.target.value;
                const headingCount = headingsList
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean).length;

                updateQuestionType(partIndex, questionTypeIndex, {
                  headingsList,
                  headingCount,
                });
              }}
              rows={4}
              className="review-textarea"
              placeholder="i. Heading one\nii. Heading two"
            />
          </label>
        ) : null}

        {hasFeaturesList ? (
          <label className="review-field review-field-wide">
            <span className="review-field-label">Features / Options List</span>
            <textarea
              value={questionType.featuresList || ''}
              onChange={(event) =>
                updateQuestionType(partIndex, questionTypeIndex, {
                  featuresList: event.target.value,
                })
              }
              rows={3}
              className="review-textarea"
                placeholder="A. Option one\nB. Option two\nC. Option three"
            />
          </label>
        ) : null}

        {hasSentenceEndingsList ? (
          <label className="review-field review-field-wide">
            <span className="review-field-label">Sentence Endings List</span>
            <textarea
              value={questionType.endingsList || ''}
              onChange={(event) =>
                updateQuestionType(partIndex, questionTypeIndex, {
                  endingsList: event.target.value,
                })
              }
              rows={3}
              className="review-textarea"
              placeholder="A. Ending one\nB. Ending two"
            />
          </label>
        ) : null}

        {hasSummaryBlock ? (
          <>
            <label className="review-field review-field-wide">
              <span className="review-field-label">Summary / Diagram Text</span>
              <textarea
                value={questionType.summaryText || ''}
                onChange={(event) =>
                  updateQuestionType(partIndex, questionTypeIndex, {
                    summaryText: event.target.value,
                  })
                }
                rows={3}
                className="review-textarea"
                placeholder="Optional text around blanks"
              />
            </label>

            <label className="review-toggle">
              <input
                type="checkbox"
                checked={Boolean(questionType.hasWordBank)}
                onChange={(event) =>
                  updateQuestionType(partIndex, questionTypeIndex, {
                    hasWordBank: event.target.checked,
                  })
                }
                className="review-toggle-input"
              />
              Has Word Bank
            </label>

            {questionType.hasWordBank ? (
              <label className="review-field review-field-wide">
                <span className="review-field-label">Word Bank (one item per line)</span>
                <textarea
                  value={questionType.wordBank || ''}
                  onChange={(event) =>
                    updateQuestionType(partIndex, questionTypeIndex, {
                      wordBank: event.target.value,
                    })
                  }
                  rows={4}
                  className="review-textarea"
                  placeholder="word 1\nword 2\nword 3"
                />
              </label>
            ) : null}

            {hasImageSupport ? (
              <label className="review-field review-field-wide">
                <span className="review-field-label">Question Image</span>
                <div
                  ref={imageDragDrop.zoneRef}
                  className={`workbench-file-drop-zone ${imageDragDrop.isDragging ? 'is-dragging' : ''}`}
                  onDragEnter={imageDragDrop.handleDragEnter}
                  onDragLeave={imageDragDrop.handleDragLeave}
                  onDragOver={imageDragDrop.handleDragOver}
                  onDrop={imageDragDrop.handleDrop}
                >
                  <input
                    ref={imageDragDrop.inputRef}
                    type="file"
                    accept="image/*"
                    onChange={(event) => { const file = event.target.files?.[0] || null; onImageChange(file); event.target.value = ''; }}
                    className="review-input"
                  />
                  <div className="workbench-file-drop-hint">
                    <span className="workbench-file-drop-icon" aria-hidden="true">🖼️</span>
                    <span className="workbench-file-drop-text">
                      {questionType.imageData?.name ? (
                        <>🖼️ {questionType.imageData.name}</>
                      ) : (
                        <><button type="button" onClick={() => imageDragDrop.trigger()} className="workbench-file-drop-link">Browse</button> or drop image</>
                      )}
                    </span>
                  </div>
                </div>
                {questionType.imageData?.src ? (
                  <div className="review-image-preview">
                    <div className="review-image-preview-head">
                      <span className="review-field-note">{questionType.imageData.name}</span>
                      <button
                        type="button"
                        onClick={() => updateQuestionType(partIndex, questionTypeIndex, { imageData: undefined })}
                        className="review-action-btn review-action-btn-danger-ghost review-action-btn-small"
                      >
                        Remove Image
                      </button>
                    </div>
                    <img
                      src={questionType.imageData.src}
                      alt={questionType.imageData.name}
                      className="review-image-preview-img"
                    />
                  </div>
                ) : null}
              </label>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="review-question-stack">
        {questionType.questions.map((_, questionIndex) => (
          <QuestionEditorRow
            key={`q-${partIndex}-${questionTypeIndex}-${questionIndex}`}
            partIndex={partIndex}
            questionTypeIndex={questionTypeIndex}
            questionIndex={questionIndex}
            questionType={questionType}
          />
        ))}

        <button
          type="button"
          onClick={() => addQuestion(partIndex, questionTypeIndex)}
          className="review-action-btn review-action-btn-secondary review-action-btn-align-start"
        >
          Add Question
        </button>
      </div>
    </article>
  );
}
