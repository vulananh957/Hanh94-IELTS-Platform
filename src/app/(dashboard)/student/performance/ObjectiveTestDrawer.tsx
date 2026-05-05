'use client';

import { useEffect, useState, useCallback } from 'react';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { firebaseApp } from '@/services/firebase';
import { resolveMaterialList } from '@/services/resolve-material';
import type { ObjectiveTestResult } from '@/services/student-objective-tests';

/* ── types ─────────────────────────────────────────────────────── */
interface AnswerRow {
  qNum: string;
  studentAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
}

interface Section {
  title: string;
  type: string;
  rows: AnswerRow[];
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

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchAnswer(student: string, correct: string): boolean {
  if (!student || !correct) return false;
  return normalize(student) === normalize(correct);
}

function flattenAnswerKey(ak: unknown): Record<string, string> {
  const raw = asRecord(ak);
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      flat[k] = v.map((x) => String(x ?? '').trim()).filter(Boolean).join(', ');
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
  // Try to group by parts from metadata
  const metadata = asRecord(testData?.metadata);
  const parts = asArray(metadata?.parts);

  if (parts.length > 0) {
    const sections: Section[] = [];

    for (const part of parts) {
      const partRec = asRecord(part);
      const partName = txt(partRec.name ?? partRec.title, 'Part');
      const questionTypes = asArray(partRec.questionTypes ?? partRec.sections);

      for (const qt of questionTypes) {
        const qtRec = asRecord(qt);
        const typeName = txt(qtRec.type ?? qtRec.label ?? qtRec.kind, 'Questions');
        const questions = asArray(qtRec.questions ?? qtRec.items);
        const startNumber = Number(qtRec.startNumber ?? 1) || 1;

        const rows: AnswerRow[] = [];
        for (let i = 0; i < questions.length; i++) {
          const qNum = String(startNumber + i);
          const correct = answerKey[qNum] ?? '';
          const student = studentAnswers[qNum] ?? '';
          rows.push({
            qNum,
            studentAnswer: student,
            correctAnswer: correct,
            isCorrect: matchAnswer(student, correct),
          });
        }

        if (rows.length > 0) {
          sections.push({
            title: partName,
            type: typeName,
            rows,
          });
        }
      }
    }

    if (sections.length > 0) return sections;
  }

  // Fallback: flat list
  const allNums = new Set([...Object.keys(answerKey), ...Object.keys(studentAnswers)]);
  const sorted = Array.from(allNums).sort((a, b) => Number(a) - Number(b));
  const rows: AnswerRow[] = sorted.map((qNum) => {
    const correct = answerKey[qNum] ?? '';
    const student = studentAnswers[qNum] ?? '';
    return {
      qNum,
      studentAnswer: student,
      correctAnswer: correct,
      isCorrect: matchAnswer(student, correct),
    };
  });

  return rows.length > 0 ? [{ title: 'All Questions', type: '', rows }] : [];
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
    setSections([]);
    setTotalCorrect(0);
    setTotalQuestions(0);
    setMaterial(EMPTY_MATERIAL);

    try {
      const db = getFirestore(firebaseApp);

      // 1) Fetch testResults doc (student answers)
      const trSnap = await getDoc(doc(db, 'testResults', test.id));
      const trData = trSnap.exists() ? (trSnap.data() as Record<string, unknown>) : null;

      // 2) Fetch tests doc (answer key + structure)
      const testSnap = await getDoc(doc(db, 'tests', test.testId));
      const testData = testSnap.exists() ? (testSnap.data() as Record<string, unknown>) : null;

      if (!trData && !testData) {
        setError('Test data not found. The test may have been deleted.');
        setLoading(false);
        return;
      }

      const rawMaterial = buildTestMaterial(testData, test.skill);
      const [pdfUrls, audioUrls] = await Promise.all([
        resolveMaterialList(rawMaterial.pdfUrls),
        resolveMaterialList(rawMaterial.audioUrls),
      ]);

      setMaterial({
        ...rawMaterial,
        pdfUrls,
        audioUrls,
      });

      // Extract answer key from tests doc
      const answerKey = flattenAnswerKey(testData?.answerKey);

      // Extract student answers from testResults doc
      const studentAnswers = flattenStudentAnswers(trData?.answers);

      // Build sections
      const builtSections = buildSections(testData, answerKey, studentAnswers);
      setSections(builtSections);

      // Compute stats
      const allRows = builtSections.flatMap((s) => s.rows);
      setTotalQuestions(allRows.length);
      setTotalCorrect(allRows.filter((r) => r.isCorrect).length);
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
              className="obj-drawer-nav-btn"
              disabled={!hasPrev}
              onClick={onPrev}
              title="Previous (←)"
            >
              <i className="fas fa-chevron-left" />
            </button>
            <button
              className="obj-drawer-nav-btn"
              disabled={!hasNext}
              onClick={onNext}
              title="Next (→)"
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
                        {test.band !== null ? test.band.toFixed(1) : '—'}
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
                        <div className="obj-section-header">
                          <h3 className="obj-section-title">{section.title}</h3>
                          {section.type && <span className="obj-section-type">{section.type}</span>}
                          <span className="obj-section-score">
                            {section.rows.filter((r) => r.isCorrect).length}/{section.rows.length}
                          </span>
                        </div>
                        <div className="obj-answer-grid">
                          {section.rows.map((row) => (
                            <div
                              key={row.qNum}
                              className={`obj-answer-row ${row.isCorrect ? 'correct' : row.studentAnswer ? 'wrong' : 'unanswered'}`}
                            >
                              <span className="obj-answer-num">Q{row.qNum}</span>
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
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
