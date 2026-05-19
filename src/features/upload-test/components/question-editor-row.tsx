import { useUploadTestStore } from '../store/use-upload-test-store';
import type { TestQuestionType } from '../types';

interface QuestionEditorRowProps {
  partIndex: number;
  questionTypeIndex: number;
  questionIndex: number;
  questionType: TestQuestionType;
}

function toStringArray(value: unknown, fallbackCount = 0): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? ''));
  }

  return Array.from({ length: fallbackCount }, () => '');
}

function toUpperStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean)));
}

function toPositiveInt(value: unknown, fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return Math.floor(next);
}

function splitNonEmptyLines(value: unknown): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines;
}

function toLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function isRomanNumeralToken(value: string): boolean {
  return /^[ivxlcdm]+$/i.test(value);
}

function isSupportedLabelToken(value: string): boolean {
  const token = value.trim();
  if (!token) return false;
  if (/^\d{1,2}$/.test(token)) return true;
  if (/^[A-Za-z]$/.test(token)) return true;
  return token.length <= 7 && isRomanNumeralToken(token);
}

function splitInlineLabeledSegments(input: string): string[] {
  const raw = input.trim();
  if (!raw) return [];

  const starts: number[] = [];
  const pattern = /(?:^|\s)([A-Za-z]|\d{1,2}|[ivxlcdmIVXLCDM]{1,7})\s*[.)\-:]\s+/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const baseIndex = match.index;
    const startsWithSpace = raw.charAt(baseIndex) === ' ';
    starts.push(startsWithSpace ? baseIndex + 1 : baseIndex);
  }

  if (starts.length < 2 || starts[0] !== 0) {
    return [raw];
  }

  const segments: string[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] : raw.length;
    const segment = raw.slice(start, end).trim();
    if (segment) {
      segments.push(segment);
    }
  }

  return segments.length > 0 ? segments : [raw];
}

function splitListItems(
  value: unknown,
  options?: {
    preferNamePairs?: boolean;
  },
): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const baseLines = splitNonEmptyLines(raw);
  const expandedLines = baseLines.flatMap((line) => splitInlineLabeledSegments(line));
  if (expandedLines.length > 1) {
    return expandedLines;
  }

  if (/[,;|]/.test(raw)) {
    return raw
      .split(/[,;|]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (options?.preferNamePairs) {
    const tokens = raw.split(/\s+/).filter(Boolean);
    const looksLikeNameToken = (token: string) => /^[A-Z][a-zA-Z'-]+$/.test(token);
    if (tokens.length >= 4 && tokens.length % 2 === 0 && tokens.every(looksLikeNameToken)) {
      const paired: string[] = [];
      for (let index = 0; index < tokens.length; index += 2) {
        paired.push(`${tokens[index]} ${tokens[index + 1]}`);
      }
      return paired;
    }
  }

  return expandedLines;
}

function parseLabeledLineOptions(
  value: unknown,
  options?: {
    keyCase?: 'lower' | 'upper';
    allowDerivedKeys?: boolean;
    preferNamePairs?: boolean;
  },
): Array<{ key: string; label: string }> {
  const keyCase = options?.keyCase || 'upper';
  const lines = splitListItems(value, { preferNamePairs: options?.preferNamePairs });

  const labeled = lines
    .map((line) => {
      const match = line.match(/^([A-Za-z]|\d{1,2}|[ivxlcdmIVXLCDM]{1,7})\s*([.)\-:]|\s)\s*(.*)$/);
      if (!match) return null;

      const rawKey = String(match[1] || '').trim();
      const text = String(match[3] || '').trim();
      if (!isSupportedLabelToken(rawKey)) return null;

      const key = keyCase === 'lower' ? rawKey.toLowerCase() : rawKey.toUpperCase();
      return {
        key,
        label: text ? `${key}. ${text}` : key,
      };
    })
    .filter((item): item is { key: string; label: string } => Boolean(item));

  if (labeled.length > 0) {
    return labeled;
  }

  if (!options?.allowDerivedKeys) {
    return [];
  }

  return lines.map((line, index) => {
    const key = toLetter(index);
    return {
      key: keyCase === 'lower' ? key.toLowerCase() : key.toUpperCase(),
      label: `${key}. ${line}`,
    };
  });
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function resolveLabeledOptionKey(
  rawValue: unknown,
  options: Array<{ key: string; label: string }>,
  normalizeKey: (value: string) => string,
): string {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';

  const normalizedRaw = normalizeToken(raw);

  const byExactKey = options.find((item) => normalizeToken(item.key) === normalizedRaw);
  if (byExactKey) return normalizeKey(byExactKey.key);

  const byLabel = options.find((item) => normalizeToken(item.label) === normalizedRaw);
  if (byLabel) return normalizeKey(byLabel.key);

  const leading = raw.match(/^([A-Za-z0-9ivxlcdmIVXLCDM]+)\s*[.)-]?/);
  if (leading?.[1]) {
    const leadToken = normalizeToken(leading[1]);
    const byLead = options.find((item) => normalizeToken(item.key) === leadToken);
    if (byLead) return normalizeKey(byLead.key);
  }

  const byContains = options.find((item) => {
    const key = normalizeToken(item.key);
    const label = normalizeToken(item.label);
    return normalizedRaw.includes(`${key}.`) || normalizedRaw.includes(`${key})`) || normalizedRaw === label;
  });

  return byContains ? normalizeKey(byContains.key) : '';
}

function resolveWordBankValue(rawValue: unknown, options: string[]): string {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';

  const labeledOptions = options.map((item, index) => {
    const match = item.match(/^([A-Za-z0-9ivxlcdmIVXLCDM]+)\s*[.)\-:]?\s*(.*)$/);
    return {
      index,
      raw: item,
      key: match?.[1] ? normalizeToken(match[1]) : '',
      text: normalizeToken(match?.[2] || item),
    };
  });

  const byExact = options.find((item) => item === raw);
  if (byExact) return byExact;

  const normalizedRaw = normalizeToken(raw);
  const byCaseInsensitive = options.find((item) => normalizeToken(item) === normalizedRaw);
  if (byCaseInsensitive) return byCaseInsensitive;

  const byToken = raw.match(/^([A-Za-z0-9ivxlcdmIVXLCDM]+)\s*[.)\-:]?/);
  if (byToken?.[1]) {
    const token = normalizeToken(byToken[1]);
    const found = labeledOptions.find((item) => item.key === token);
    if (found) return found.raw;
  }

  const byIndex = raw.match(/^\d{1,2}$/);
  if (byIndex) {
    const idx = Number(byIndex[0]) - 1;
    if (idx >= 0 && idx < options.length) {
      return options[idx];
    }
  }

  const candidates = raw
    .split('/')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const found = options.find((item) => normalizeToken(item) === normalizeToken(candidate));
    if (found) return found;
  }

  const byText = labeledOptions.find((item) => item.text.length > 0 && normalizeToken(raw).includes(item.text));
  if (byText) return byText.raw;

  return '';
}

export function QuestionEditorRow({
  partIndex,
  questionTypeIndex,
  questionIndex,
  questionType,
}: QuestionEditorRowProps) {
  const updateQuestion = useUploadTestStore((state) => state.updateQuestion);
  const addOption = useUploadTestStore((state) => state.addOption);
  const removeOption = useUploadTestStore((state) => state.removeOption);
  const removeQuestion = useUploadTestStore((state) => state.removeQuestion);

  const question = (questionType.questions[questionIndex] || {}) as Record<string, unknown>;
  const questionText = String(question.question || '');
  const options = toStringArray(question.options, /single answer|choose multiple/i.test(questionType.type) ? 4 : 0);

  const isChooseMultiple = /multiple choice.*choose multiple/i.test(questionType.type);
  const isSingleChoice = /multiple choice.*single answer/i.test(questionType.type);
  const isMatchingHeadings = /matching headings/i.test(questionType.type);
  const isMatchingSentenceEndings = /matching sentence endings/i.test(questionType.type);
  const isMatchingFeaturesLike = /matching features|pick from a list|matching \(info\/features\/sentence halves\)/i.test(questionType.type);
  const isTFNG = /true\s*\/\s*false\s*\/\s*not\s*given/i.test(questionType.type);
  const isYNNG = /yes\s*\/\s*no\s*\/\s*not\s*given/i.test(questionType.type);
  const headingOptions = parseLabeledLineOptions(questionType.headingsList).map((item) => ({
    key: item.key.toLowerCase(),
    label: item.label,
  }));
  const endingOptions = parseLabeledLineOptions(questionType.endingsList, {
    keyCase: 'upper',
    allowDerivedKeys: true,
  }).map((item) => ({
    key: item.key.toUpperCase(),
    label: item.label,
  }));
  const featureOptions = parseLabeledLineOptions(questionType.featuresList, {
    keyCase: 'upper',
    allowDerivedKeys: true,
    preferNamePairs: true,
  }).map((item) => ({
    key: item.key.toUpperCase(),
    label: item.label,
  }));
  const wordBankOptions = splitNonEmptyLines(questionType.wordBank);
  const resolvedHeadingValue = resolveLabeledOptionKey(question.correctHeading, headingOptions, (value) => value.toLowerCase());
  const resolvedEndingValue = resolveLabeledOptionKey(question.correctEnding, endingOptions, (value) => value.toUpperCase());
  const featureRawAnswer = String(
    question.correctAnswer
      || (Array.isArray(question.correctAnswers) ? question.correctAnswers[0] : '')
      || '',
  ).trim();
  const resolvedFeatureValue = resolveLabeledOptionKey(featureRawAnswer, featureOptions, (value) => value.toUpperCase());
  const wordBankRawAnswer = String(
    question.correctAnswer
      || (Array.isArray(question.correctAnswers) ? question.correctAnswers[0] : '')
      || '',
  ).trim();
  const resolvedWordBankValue = resolveWordBankValue(wordBankRawAnswer, wordBankOptions);

  const blockLabel = isChooseMultiple
    ? (() => {
        let blockStart = questionType.startNumber || 1;
        for (let i = 0; i < questionIndex; i += 1) {
          const previous = questionType.questions[i] as Record<string, unknown>;
          blockStart += toPositiveInt(previous?.choiceCount, 2);
        }
        const currentChoiceCount = toPositiveInt(question.choiceCount, 2);
        const blockEnd = blockStart + currentChoiceCount - 1;
        return `${blockStart}-${blockEnd}`;
      })()
    : String((questionType.startNumber || 1) + questionIndex);

  function updateOptionText(optionIndex: number, value: string) {
    const nextOptions = [...options];
    nextOptions[optionIndex] = value;
    updateQuestion(partIndex, questionTypeIndex, questionIndex, { options: nextOptions });
  }

  function renderOptionsEditor() {
    if (!isChooseMultiple && !isSingleChoice) {
      return null;
    }

    const selectedSingle = String(question.correctAnswer || '').trim().toUpperCase();

    return (
      <div className="review-options-card">
        <div className="review-options-head">
          <h5 className="review-options-title">Options</h5>
          <button
            type="button"
            onClick={() => addOption(partIndex, questionTypeIndex, questionIndex)}
            className="review-action-btn review-action-btn-secondary review-action-btn-small"
          >
            Add Option
          </button>
        </div>

        <div className="review-option-list">
          {options.map((option, optionIndex) => {
            const letter = toLetter(optionIndex);
            const checkedMulti = toUpperStringArray(question.correctAnswers).includes(letter);

            return (
              <div key={`${letter}-${optionIndex}`} className="review-option-row">
                <div className="review-option-choice">
                  {isSingleChoice ? (
                    <input
                      type="radio"
                      aria-label={`Select ${letter} as correct answer`}
                      checked={selectedSingle === letter}
                      onChange={() =>
                        updateQuestion(partIndex, questionTypeIndex, questionIndex, {
                          correctAnswer: letter,
                        })
                      }
                    />
                  ) : null}

                  {isChooseMultiple ? (
                    <input
                      type="checkbox"
                      aria-label={`Toggle ${letter} as a correct answer`}
                      checked={checkedMulti}
                      onChange={(event) => {
                        const current = toUpperStringArray(question.correctAnswers);
                        const choiceCount = toPositiveInt(question.choiceCount, 2);
                        let next = current;

                        if (event.target.checked) {
                          next = Array.from(new Set([...current, letter])).slice(0, choiceCount);
                        } else {
                          next = current.filter((item) => item !== letter);
                        }

                        updateQuestion(partIndex, questionTypeIndex, questionIndex, {
                          correctAnswers: next,
                        });
                      }}
                    />
                  ) : null}
                </div>

                <div className="review-option-input-wrap">
                  <span className="review-option-letter">{letter}.</span>
                  <input
                    value={option}
                    onChange={(event) => updateOptionText(optionIndex, event.target.value)}
                    placeholder={`Option ${letter}`}
                    className="review-input review-option-input"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => removeOption(partIndex, questionTypeIndex, questionIndex, optionIndex)}
                  disabled={options.length <= 1}
                  className="review-action-btn review-action-btn-danger-ghost review-action-btn-small review-option-remove"
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderAnswerEditor() {
    if (isMatchingHeadings) {
      return (
        <div className="review-answer-grid">
          <label className="review-field">
            <span className="review-field-label">Paragraph Letter</span>
            <input
              value={String(question.paragraphLetter || '')}
              onChange={(event) =>
                updateQuestion(partIndex, questionTypeIndex, questionIndex, {
                  paragraphLetter: event.target.value.toUpperCase(),
                })
              }
              placeholder="A"
              className="review-input"
            />
          </label>

          <label className="review-field">
            <span className="review-field-label">Correct Heading</span>
            {headingOptions.length > 0 ? (
              <select
                value={resolvedHeadingValue}
                onChange={(event) =>
                  updateQuestion(partIndex, questionTypeIndex, questionIndex, {
                    correctHeading: event.target.value.toLowerCase(),
                  })
                }
                className="review-select"
              >
                <option value="">Select heading</option>
                {headingOptions.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={String(question.correctHeading || '')}
                onChange={(event) =>
                  updateQuestion(partIndex, questionTypeIndex, questionIndex, {
                    correctHeading: event.target.value.toLowerCase(),
                  })
                }
                placeholder="iv"
                className="review-input"
              />
            )}
          </label>
        </div>
      );
    }

    if (isMatchingSentenceEndings) {
      return (
        <label className="review-field">
          <span className="review-field-label">Correct Ending</span>
          {endingOptions.length > 0 ? (
            <select
              value={resolvedEndingValue}
              onChange={(event) =>
                updateQuestion(partIndex, questionTypeIndex, questionIndex, {
                  correctEnding: event.target.value.toUpperCase(),
                })
              }
              className="review-select"
            >
              <option value="">Select ending</option>
              {endingOptions.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={String(question.correctEnding || '')}
              onChange={(event) =>
                updateQuestion(partIndex, questionTypeIndex, questionIndex, {
                  correctEnding: event.target.value.toUpperCase(),
                })
              }
              placeholder="A"
              className="review-input"
            />
          )}
        </label>
      );
    }

    if (isMatchingFeaturesLike && featureOptions.length > 0) {
      return (
        <label className="review-field">
          <span className="review-field-label">Correct Answer</span>
          <select
            value={resolvedFeatureValue}
            onChange={(event) =>
              updateQuestion(partIndex, questionTypeIndex, questionIndex, {
                correctAnswer: event.target.value.toUpperCase(),
              })
            }
            className="review-select"
          >
            <option value="">Select option</option>
            {featureOptions.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      );
    }

    if (questionType.hasWordBank && wordBankOptions.length > 0) {
      return (
        <label className="review-field">
          <span className="review-field-label">Correct Answer (Word Bank)</span>
          <select
            value={resolvedWordBankValue}
            onChange={(event) =>
              updateQuestion(partIndex, questionTypeIndex, questionIndex, {
                correctAnswer: event.target.value,
              })
            }
            className="review-select"
          >
            <option value="">Select word/phrase</option>
            {wordBankOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      );
    }

    if (isChooseMultiple) {
      const choiceCount = toPositiveInt(question.choiceCount, 2);
      const optionCount = Math.max(toPositiveInt(question.optionCount, options.length), options.length);

      return (
        <div className="review-answer-grid">
          <label className="review-field">
            <span className="review-field-label">Choices Required</span>
            <input
              type="number"
              min={1}
              max={Math.max(optionCount, 1)}
              value={choiceCount}
              onChange={(event) => {
                const nextChoiceCount = Math.min(
                  Math.max(toPositiveInt(event.target.value, 2), 1),
                  Math.max(optionCount, 1),
                );
                const currentCorrect = toUpperStringArray(question.correctAnswers).slice(0, nextChoiceCount);
                updateQuestion(partIndex, questionTypeIndex, questionIndex, {
                  choiceCount: nextChoiceCount,
                  correctAnswers: currentCorrect,
                });
              }}
              className="review-input"
            />
          </label>

          <label className="review-field">
            <span className="review-field-label">Option Count</span>
            <input
              type="number"
              min={Math.max(options.length, 1)}
              value={optionCount}
              onChange={(event) => {
                const next = Math.max(toPositiveInt(event.target.value, optionCount), options.length);
                updateQuestion(partIndex, questionTypeIndex, questionIndex, { optionCount: next });
              }}
              className="review-input"
            />
          </label>
        </div>
      );
    }

    if (isTFNG || isYNNG) {
      const optionsAnswer = isTFNG
        ? ['TRUE', 'FALSE', 'NOT GIVEN']
        : ['YES', 'NO', 'NOT GIVEN'];

      return (
        <label className="review-field">
          <span className="review-field-label">Correct Answer</span>
          <select
            value={String(question.correctAnswer || '')}
            onChange={(event) =>
              updateQuestion(partIndex, questionTypeIndex, questionIndex, {
                correctAnswer: event.target.value,
              })
            }
            className="review-select"
          >
            <option value="">Select</option>
            {optionsAnswer.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      );
    }

    if (isSingleChoice) {
      return null;
    }

    return (
      <label className="review-field">
        <span className="review-field-label">Correct Answer</span>
        <input
          value={String(question.correctAnswer || '')}
          onChange={(event) =>
            updateQuestion(partIndex, questionTypeIndex, questionIndex, {
              correctAnswer: event.target.value,
            })
          }
          placeholder="Enter accepted answer(s)"
          className="review-input"
        />
      </label>
    );
  }

  return (
    <div className="review-question-card">
      <div className="review-question-head">
        <h4 className="review-question-title">
          <span className="review-question-badge">Question {blockLabel}</span>
        </h4>
        <button
          type="button"
          onClick={() => removeQuestion(partIndex, questionTypeIndex, questionIndex)}
          className="review-action-btn review-action-btn-danger review-action-btn-small"
        >
          Delete Question
        </button>
      </div>

      <label className="review-field">
        <span className="review-field-label">Question Text</span>
        <textarea
          value={questionText}
          onChange={(event) =>
            updateQuestion(partIndex, questionTypeIndex, questionIndex, {
              question: event.target.value,
            })
          }
          rows={3}
          className="review-textarea"
        />
      </label>

      {isChooseMultiple ? (
        <label className="review-field">
          <span className="review-field-label">Instruction</span>
          <input
            value={String(question.instructions || '')}
            onChange={(event) =>
              updateQuestion(partIndex, questionTypeIndex, questionIndex, {
                instructions: event.target.value,
              })
            }
            placeholder="Choose TWO letters, A-F"
            className="review-input"
          />
        </label>
      ) : null}

      {renderAnswerEditor()}
      {renderOptionsEditor()}
    </div>
  );
}
