'use client';

import { useEffect, useState, useCallback } from 'react';
import { getFirestore, doc, getDoc, updateDoc } from 'firebase/firestore';
import { firebaseApp } from '@/services/firebase';
import { calculateObjectiveScore } from '@/lib/score-calculator';
import { calculateIELTSBand } from '@/app/(dashboard)/student/take-test/take-test-utils';
import type { ObjectiveTestResult } from '@/services/student-objective-tests';
import type { TestPart } from '@/features/upload-test/types';

/* ── types ─────────────────────────────────────────────────────── */
interface AnswerRow {
  qNum: string;
  qLabel: string;
  studentAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  score: number;
  maxScore: number;
}

interface Section {
  title: string;
  rows: AnswerRow[];
  blocks: {
    type: string;
    subtitle?: string;
    rows: AnswerRow[];
  }[];
}

interface TestMaterial {
  pdfUrls: string[];
  audioUrls: string[];
  passageText: string;
}

const EMPTY_MATERIAL: TestMaterial = {
  pdfUrls: [],
  audioUrls: [],
  passageText: '',
};

interface ObjDrawerProps {
  test: ObjectiveTestResult;
  index: number;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onComputedResult?: (result: { correctAnswers: number; totalQuestions: number; band: number }) => void;
}

/* ── helpers ───────────────────────────────────────────────────── */
function asRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function txt(v: unknown, fb = ''): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fb;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return next > 0 ? Math.floor(next) : fallback;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function formatQuestionLabel(start: number, end: number): string {
  return start === end ? String(start) : `${start}–${end}`;
}

function splitAnswerTokens(value: string): string[] {
  return value
    .split(/[\s,;/]+/)
    .map((choice) => choice.trim().toUpperCase())
    .filter(Boolean);
}

function isChooseMultipleType(type: string): boolean {
  return /multiple choice.*choose multiple/i.test(type);
}

function matchAnswer(student: string, correct: string, type = ''): boolean {
  if (!student || !correct) return false;
  const s = normalize(student);
  if (!s) return false;

  // Extract leading letter BEFORE normalizing so we catch "E." in answer keys like "E. People..."
  const keyLetter = student.match(/^[A-Z](?:\.|\s)/)?.[0]?.toUpperCase()
    ?? correct.match(/^[A-Z](?:\.|\s)/)?.[0]?.toUpperCase();
  const stuLetter = student.match(/^[A-Z](?:\.|\s)/)?.[0]?.toUpperCase();

  if (keyLetter && stuLetter) {
    return keyLetter === stuLetter;
  }

  // Support "/" as a separator for multiple accepted answers (e.g., "six/6")
  const acceptedAnswers = correct
    .split('/')
    .map((token) => normalize(token.trim()))
    .filter(Boolean);

  return acceptedAnswers.some((c) => s === c);
}

function formatCorrectAnswer(question: Record<string, unknown>, typeName: string): string {
  if (isChooseMultipleType(typeName)) {
    const answers = asArray(question.correctAnswers)
      .map((value) => String(value ?? '').trim().toUpperCase())
      .filter(Boolean);
    if (answers.length > 0) return answers.join(' ');
  }

  return txt(
    question.correctAnswer
    ?? (asArray(question.correctAnswers).length > 0 ? asArray(question.correctAnswers)[0] : '')
    ?? '',
    '',
  );
}

function flattenAnswerKey(ak: unknown): Record<string, string> {
  const raw = asRecord(ak);
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      flat[k] = v.map((x) => String(x ?? '').trim()).filter(Boolean).join('/ ');
    } else {
      flat[k] = String(v ?? '').trim();
    }
  }
  return flat;
}

function flattenStudentAnswers(ans: unknown): Record<string, string> {
  const raw = asRecord(ans);
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    flat[k] = String(v ?? '').trim();
  }
  return flat;
}

function getSubAnswerScore(
  studentAnswers: Record<string, string>,
  startNumber: number,
  choiceCount: number,
  correctAnswerTokens: string[],
): { score: number; matchedTokens: string[] } {
  const exactKey = `${startNumber}-${startNumber + choiceCount - 1}`;
  const studentRaw = studentAnswers[exactKey] || studentAnswers[String(startNumber)] || '';
  const studentTokens = Array.from(new Set(splitAnswerTokens(studentRaw)));

  const matchedTokens = studentTokens.filter((t) =>
    correctAnswerTokens.some((c) => matchAnswer(t, c)),
  );
  const score = Math.min(matchedTokens.length, correctAnswerTokens.length);
  return { score, matchedTokens };
}

function isLikelyUrl(value: string): boolean {
  const text = value.trim().toLowerCase();
  return (
    text.startsWith('http://') ||
    text.startsWith('https://') ||
    text.startsWith('gs://') ||
    text.startsWith('/') ||
    text.includes('/o/') ||
    text.includes('%2f')
  );
}

function isAudioUrl(value: string): boolean {
  const text = value.trim().toLowerCase();
  return /\.(mp3|wav|m4a|ogg|aac|webm)(\?|#|$)/.test(text) || (isLikelyUrl(text) && text.includes('audio'));
}

function isPdfUrl(value: string): boolean {
  const text = value.trim().toLowerCase();
  return /\.pdf(\?|#|$)/.test(text) || (isLikelyUrl(text) && text.includes('pdf'));
}

function collectRawStrings(value: unknown, output: string[], depth = 0): void {
  if (depth > 7 || value == null) return;

  if (typeof value === 'string') {
    const text = value.trim();
    if (text) output.push(text);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectRawStrings(item, output, depth + 1));
    return;
  }

  const record = asRecord(value);
  Object.values(record).forEach((item) => collectRawStrings(item, output, depth + 1));
}

function collectMediaUrls(values: unknown[], kind: 'any' | 'audio' | 'pdf' = 'any'): string[] {
  const strings: string[] = [];
  values.forEach((value) => collectRawStrings(value, strings));

  const filtered = strings.filter((item) => {
    if (kind === 'audio') return isAudioUrl(item);
    if (kind === 'pdf') return isPdfUrl(item);
    return isLikelyUrl(item);
  });

  return Array.from(new Set(filtered));
}

function buildTestMaterial(
  testData: Record<string, unknown> | null,
  skill: ObjectiveTestResult['skill'],
): TestMaterial {
  const record = asRecord(testData);
  const files = asRecord(record?.files);
  const metadata = asRecord(record?.metadata);

  const pdfUrls = collectMediaUrls(
    [
      files?.reading,
      files?.readingPdf,
      record?.reading,
      record?.readingFile,
      record?.readingPassage,
      asArray(record?.readingSections),
      metadata?.parts,
    ],
    'pdf',
  );

  const audioUrls = collectMediaUrls(
    [
      files,
      files?.listening,
      files?.audio,
      files?.listeningAudio,
      record?.listening,
      record?.audioFiles,
      record?.audio,
      record?.listeningAudio,
      asArray(record?.listeningSections),
      metadata?.parts,
    ],
    'audio',
  );

  return {
    pdfUrls: skill === 'reading' ? pdfUrls : [],
    audioUrls: skill === 'listening' ? audioUrls : [],
    passageText: txt(record?.passage ?? record?.readingPassageText ?? record?.readingText ?? '', ''),
  };
}

function buildSections(
  testData: Record<string, unknown> | null,
  answerKey: Record<string, string>,
  studentAnswers: Record<string, string>,
): Section[] {
  const metadata = asRecord(testData?.metadata);
  const parts = asArray(metadata?.parts);

  if (parts.length > 0) {
    const sections: Section[] = [];

    for (const [partIndex, part] of parts.entries()) {
      const partRec = asRecord(part);
      const partName = txt(partRec.name ?? partRec.title, `Part ${partIndex + 1}`);
      const questionTypes = asArray(partRec.questionTypes ?? partRec.sections);
      let currentNumber = toPositiveInt(partRec.startNumber, 1);
      const blocks: Section['blocks'] = [];
      const rows: AnswerRow[] = [];

      for (const qt of questionTypes) {
        const qtRec = asRecord(qt);
        const typeName = txt(qtRec.type ?? qtRec.label ?? qtRec.kind, 'Questions');
        const questions = asArray(qtRec.questions ?? qtRec.items);
        const blockRows: AnswerRow[] = [];
        currentNumber = toPositiveInt(qtRec.startNumber, currentNumber);

        if (isChooseMultipleType(typeName)) {
          for (const question of questions) {
            const questionRec = asRecord(question);
            const choiceCount = toPositiveInt(questionRec.choiceCount, 2);
            const startNumber = currentNumber;
            const endNumber = startNumber + choiceCount - 1;
            const groupLabel = formatQuestionLabel(startNumber, endNumber);

            // Get the full correct answer string (e.g. "A B" for a 2-item group)
            const rawCorrect = formatCorrectAnswer(questionRec, typeName) || answerKey[String(startNumber)] || '';
            // Build per-sub-question correct answers: "A", "B" → ["A", "B"]
            const correctAnswerTokens = Array.from(new Set(splitAnswerTokens(rawCorrect)));

            let groupTotalScore = 0;
            const studentSubAnswers: string[] = [];
            // Per-sub-question correct answers for display
            const subCorrectAnswers: string[] = [];

            for (let subIdx = 0; subIdx < choiceCount; subIdx++) {
              const subNum = startNumber + subIdx;
              const correctToken = correctAnswerTokens[subIdx] || '';
              subCorrectAnswers.push(correctToken);
              // take-test stores grouped answers under the group key (e.g. "17-18"), not individual keys
              const groupKey = `${startNumber}-${startNumber + choiceCount - 1}`;
              const subScore = getSubAnswerScore(studentAnswers, startNumber, choiceCount, [correctToken]).score;
              groupTotalScore += subScore;
              // Extract the student's answer for this sub-question from the group answer string
              const groupAnswer = studentAnswers[groupKey] || '';
              const studentTokens = Array.from(new Set(splitAnswerTokens(groupAnswer)));
              const subAnswer = studentTokens[subIdx] || '';
              studentSubAnswers.push(subAnswer);
            }

            blockRows.push({
              qNum: groupLabel,
              qLabel: groupLabel,
              studentAnswer: studentSubAnswers.filter(Boolean).join('; '),
              correctAnswer: subCorrectAnswers.join('; '),
              isCorrect: groupTotalScore === choiceCount,
              score: groupTotalScore,
              maxScore: choiceCount,
            });

            currentNumber = endNumber + 1;
          }
        } else {
          const questionCount = Math.max(
            toPositiveInt(qtRec.questionCount, 0),
            questions.length,
          );

          for (let index = 0; index < questionCount; index += 1) {
            const qNum = String(currentNumber + index);
            const questionRec = asRecord(questions[index]);
            const correct = txt(questionRec.correctAnswer ?? answerKey[qNum] ?? '', '');
            const student = studentAnswers[qNum] ?? '';
            const isCorrect = matchAnswer(student, correct, typeName);

            blockRows.push({
              qNum,
              qLabel: qNum,
              studentAnswer: student,
              correctAnswer: correct,
              isCorrect,
              score: isCorrect ? 1 : 0,
              maxScore: 1,
            });
          }

          currentNumber += questionCount;
        }

        if (blockRows.length === 0) continue;

        blocks.push({
          type: typeName,
          subtitle: txt(qtRec.instructions, ''),
          rows: blockRows,
        });
        rows.push(...blockRows);
      }

      if (blocks.length > 0) {
        sections.push({
          title: partName,
          rows,
          blocks,
        });
      }
    }

    if (sections.length > 0) return sections;
  }

  const allNums = new Set([...Object.keys(answerKey), ...Object.keys(studentAnswers)]);
  const sorted = Array.from(allNums).sort((a, b) => Number(a) - Number(b));
  const rows: AnswerRow[] = sorted.map((qNum) => {
    const correct = answerKey[qNum] ?? '';
    const student = studentAnswers[qNum] ?? '';
    const isCorrect = matchAnswer(student, correct);

    return {
      qNum,
      qLabel: qNum,
      studentAnswer: student,
      correctAnswer: correct,
      isCorrect,
      score: isCorrect ? 1 : 0,
      maxScore: 1,
    };
  });

  return rows.length > 0 ? [{ title: 'All Questions', rows, blocks: [{ type: 'Questions', rows }] }] : [];
}

/* ── component ─────────────────────────────────────────────────── */
export function ObjectiveTestDrawer({
  test,
  index,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onComputedResult,
}: ObjDrawerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [totalCorrect, setTotalCorrect] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [material, setMaterial] = useState<TestMaterial>(EMPTY_MATERIAL);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const db = getFirestore(firebaseApp);

      // 1) Fetch both docs in parallel
      const [trSnap, testSnap] = await Promise.all([
        getDoc(doc(db, 'testResults', test.id)),
        getDoc(doc(db, 'tests', test.testId)),
      ]);
      const trData = trSnap.exists() ? (trSnap.data() as Record<string, unknown>) : null;
      const testData = testSnap.exists() ? (testSnap.data() as Record<string, unknown>) : null;

      if (!trData && !testData) {
        setError('Test data not found. The test may have been deleted.');
        setLoading(false);
        return;
      }

      setMaterial(buildTestMaterial(testData, test.skill));

      // Extract answer key from tests doc
      const answerKey = flattenAnswerKey(testData?.answerKey);

      // Extract student answers from testResults doc
      const studentAnswers = flattenStudentAnswers(trData?.answers);

      // Build sections for display
      const builtSections = buildSections(testData, answerKey, studentAnswers);
      setSections(builtSections);

      // Also compute and persist the summary scores using the shared calculator
      const testParts = asArray(asRecord(testData?.metadata)?.parts) as TestPart[];
      if (testParts.length > 0 && trData) {
        const { correctAnswers, totalQuestions, band } = calculateObjectiveScore({
          answers: flattenStudentAnswers(trData?.answers),
          answerKey,
          parts: testParts,
          skill: test.skill,
        });

        setTotalQuestions(totalQuestions);
        setTotalCorrect(correctAnswers);

        await updateDoc(doc(db, 'testResults', test.id), {
          ieltsBand: band,
          correctAnswers,
          totalQuestions,
        });
      } else {
        const allRows = builtSections.flatMap((s) => s.rows);
        setTotalCorrect(allRows.reduce((t, r) => t + r.score, 0));
        setTotalQuestions(allRows.reduce((t, r) => t + r.maxScore, 0));
      }
    } catch (err) {
      console.error('[OBJ DRAWER]', err);
      setError('Failed to load test details.');
    } finally {
      setLoading(false);
    }
  }, [test.id, test.testId, test.skill]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  // Report computed result to parent so list cards use correct (not Firestore-stored) values
  useEffect(() => {
    if (!onComputedResult || totalCorrect === 0 && totalQuestions === 0) return;
    const band = totalCorrect > 0 ? calculateIELTSBand(totalCorrect, test.skill as 'reading' | 'listening') : 0;
    onComputedResult({ correctAnswers: totalCorrect, totalQuestions, band });
  }, [totalCorrect, totalQuestions, test.skill, onComputedResult]);

  // Keyboard nav
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && hasPrev && onPrev) onPrev();
      if (e.key === 'ArrowRight' && hasNext && onNext) onNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const pct = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
  const computedBand = totalCorrect > 0 ? calculateIELTSBand(totalCorrect, test.skill) : 0;
  const materialTitle = test.skill === 'reading' ? 'Reading material' : 'Listening audio';
  const materialSubtitle = test.skill === 'reading'
    ? 'Source file shown to the student during the reading test.'
    : 'Source tracks used for the listening test.';
  const materialItems = test.skill === 'reading' ? material.pdfUrls : material.audioUrls;
  const hasMaterial = materialItems.length > 0 || (test.skill === 'reading' && Boolean(material.passageText));

  return (
    <div className="obj-drawer-overlay" onClick={onClose}>
      <div className="obj-drawer" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ─────────────────────────────────────── */}
        <div className="obj-drawer-header">
          <div className="obj-drawer-header-left">
            <button className="obj-drawer-close" onClick={onClose} title="Close">
              <i className="fas fa-times" />
            </button>
            <div className="obj-drawer-title-block">
              <span className="obj-drawer-num">#{index}</span>
              <h2 className="obj-drawer-title">{test.testName}</h2>
            </div>
          </div>
          <div className="obj-drawer-nav">
            <button
              className="obj-nav-btn"
              disabled={!hasPrev}
              onClick={onPrev}
              title="Previous result"
            >
              <i className="fas fa-chevron-left" />
            </button>
            <button
              className="obj-nav-btn"
              disabled={!hasNext}
              onClick={onNext}
              title="Next result"
            >
              <i className="fas fa-chevron-right" />
            </button>
          </div>
        </div>

        {/* ── Body ───────────────────────────────────────── */}
        <div className="obj-drawer-body">

          {loading && (
            <div className="obj-drawer-loading">
              <div className="sd-spinner" />
              <span>Loading test details…</span>
            </div>
          )}

          {error && !loading && (
            <div className="obj-drawer-error">
              <i className="fas fa-exclamation-triangle" />
              <p>{error}</p>
            </div>
          )}

          {!loading && !error && (
            <div className="obj-drawer-split">
              <aside className={`obj-material-pane ${test.skill}`}>
                <div className="obj-material-header">
                  <div>
                    <div className="obj-material-kicker">Test material</div>
                    <h3 className="obj-material-title">{materialTitle}</h3>
                  </div>
                  <div className="obj-section-score">
                    {materialItems.length > 0 ? `${materialItems.length} file${materialItems.length > 1 ? 's' : ''}` : '0 file'}
                  </div>
                </div>

                <div className="obj-material-body">
                  <p className="obj-summary-meta-label" style={{ margin: 0 }}>
                    {materialSubtitle}
                  </p>

                  {test.skill === 'reading' && material.pdfUrls.length > 0 && (
                    <>
                      <div className="obj-material-links">
                        {material.pdfUrls.map((url, materialIndex) => (
                          <a
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="obj-material-link"
                          >
                            <i className="fas fa-file-pdf" />
                            <span>Open PDF {materialIndex + 1}</span>
                            <i className="fas fa-external-link-alt" style={{ marginLeft: 'auto', fontSize: '0.75rem' }} />
                          </a>
                        ))}
                      </div>
                      <div className="obj-material-frame">
                        <iframe
                          className="obj-material-iframe"
                          src={material.pdfUrls[0]}
                          title="Reading material PDF"
                        />
                      </div>
                    </>
                  )}

                  {test.skill === 'reading' && material.pdfUrls.length === 0 && material.passageText && (
                    <div className="obj-material-text">{material.passageText}</div>
                  )}

                  {test.skill === 'listening' && material.audioUrls.length > 0 && (
                    <div className="obj-material-audio-stack">
                      {material.audioUrls.map((url, materialIndex) => (
                        <div className="obj-material-audio-card" key={url}>
                          <div className="obj-material-audio-head">
                            <div>
                              <div className="obj-material-audio-part">Part {materialIndex + 1}</div>
                              <div className="obj-material-audio-name">Listening track</div>
                            </div>
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="obj-material-link"
                            >
                              Open
                            </a>
                          </div>
                          <audio controls className="obj-material-audio-player">
                            <source src={url} />
                            Your browser does not support the audio element.
                          </audio>
                        </div>
                      ))}
                    </div>
                  )}

                  {!hasMaterial && (
                    <div className="obj-material-empty">
                      <i className="fas fa-folder-open" />
                      <p>No test material found for this test.</p>
                    </div>
                  )}
                </div>
              </aside>

              <section className="obj-drawer-main">
                <div className="obj-drawer-layout">
                  {/* ── Score summary ─────────────────────────── */}
                  <div className="obj-drawer-summary">
                    <div className="obj-summary-band">
                      <div className="obj-summary-band-value">
                        {computedBand > 0 ? computedBand.toFixed(1) : '0.0'}
                      </div>
                      <div className="obj-summary-band-label">IELTS Band</div>
                    </div>

                    <div className="obj-summary-stats">
                      <div className="obj-summary-stat">
                        <div className="obj-summary-stat-value obj-correct">{totalCorrect}</div>
                        <div className="obj-summary-stat-label">Correct</div>
                      </div>
                      <div className="obj-summary-stat">
                        <div className="obj-summary-stat-value obj-wrong">{totalQuestions - totalCorrect}</div>
                        <div className="obj-summary-stat-label">Wrong</div>
                      </div>
                      <div className="obj-summary-stat">
                        <div className="obj-summary-stat-value">{totalQuestions}</div>
                        <div className="obj-summary-stat-label">Total</div>
                      </div>
                    </div>

                    <div className="obj-summary-pct-bar">
                      <div className="obj-summary-pct-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="obj-summary-pct-label">{pct}% Accuracy</div>

                    <div className="obj-summary-meta">
                      <div className="obj-summary-meta-row">
                        <span className="obj-summary-meta-label">Skill</span>
                        <span className={`obj-skill-tag ${test.skill}`}>{test.skill.toUpperCase()}</span>
                      </div>
                      <div className="obj-summary-meta-row">
                        <span className="obj-summary-meta-label">Date</span>
                        <span>{test.completedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      </div>
                    </div>
                  </div>

                  {/* ── Answer detail ─────────────────────────── */}
                  <div className="obj-drawer-detail">
                    {sections.length === 0 && (
                      <div className="obj-drawer-empty">
                        <i className="fas fa-info-circle" />
                        <p>No answer details available for this test.</p>
                      </div>
                    )}

                    {sections.map((section, si) => (
                      <div key={si} className="obj-section">
                        <div className="obj-section-part">{section.title}</div>
                        <div className="obj-section-header">
                          <div className="obj-section-header-main">
                            <h3 className="obj-section-title">{section.blocks.length > 1 ? 'Mixed question types' : (section.blocks[0]?.type || 'Questions')}</h3>
                            <p className="obj-section-note">
                              {section.blocks.length > 1
                                ? `${section.blocks.length} question types in this ${section.title.toLowerCase()}`
                                : (section.blocks[0]?.subtitle || '')}
                            </p>
                          </div>
                          <span className="obj-section-score">
                            {section.rows.reduce((total, row) => total + row.score, 0)}/{section.rows.reduce((total, row) => total + row.maxScore, 0)}
                          </span>
                        </div>
                        <div className="obj-part-blocks">
                          {section.blocks.map((block, blockIndex) => (
                            <div key={`${section.title}-${blockIndex}`} className="obj-part-block">
                              <div className="obj-part-block-header">
                                <div className="obj-section-header-main">
                                  <h4 className="obj-part-block-title">{block.type || 'Questions'}</h4>
                                  {block.subtitle && <p className="obj-part-block-note">{block.subtitle}</p>}
                                </div>
                                <span className="obj-part-block-score">
                                  {block.rows.reduce((total, row) => total + row.score, 0)}/{block.rows.reduce((total, row) => total + row.maxScore, 0)}
                                </span>
                              </div>
                              <div className="obj-answer-grid">
                                {block.rows.map((row) => (
                                  <div
                                    key={row.qNum}
                                    className={`obj-answer-row ${row.isCorrect ? 'correct' : row.studentAnswer ? 'wrong' : 'unanswered'}`}
                                  >
                                    <span className="obj-answer-num">Q{row.qLabel}</span>
                                    <span className="obj-answer-student">
                                      {row.studentAnswer || <em className="obj-no-answer">—</em>}
                                    </span>
                                    {!row.isCorrect && row.correctAnswer && (
                                      <span className="obj-answer-correct">
                                        <i className="fas fa-check" /> {row.correctAnswer}
                                      </span>
                                    )}
                                    <span className="obj-answer-icon">
                                      {row.isCorrect ? (
                                        <i className="fas fa-check-circle obj-icon-correct" />
                                      ) : (
                                        <i className="fas fa-times-circle obj-icon-wrong" />
                                      )}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
