'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { firebaseApp } from '@/services/firebase';

interface TeacherWritingResultDetailDrawerProps {
  testResultId: string;
  testId: string;
  testName: string;
  studentName: string;
  className: string;
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

function asText(v: unknown, fb = ''): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fb;
}

function pickText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asText(record[key]);
    if (value) return value;
  }
  return '';
}

function asDate(value: unknown, fallback: Date | null = null): Date | null {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && 'toDate' in (value as Record<string, unknown>) && typeof (value as { toDate?: unknown }).toDate === 'function') {
    try {
      return ((value as { toDate: () => Date }).toDate());
    } catch {
      return fallback;
    }
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

function formatDate(d: Date | undefined | null): string {
  if (!d) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function gradedByDisplay(raw?: string): string {
  if (!raw) return 'Unknown';
  if (raw.includes('vulananh957') || raw.includes('hanh')) return 'Ms. Hanh Le';
  return raw;
}

function Accordion({ title, defaultOpen = false, children }: { title: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="wrd-accordion">
      <button className="wrd-accordion-header" onClick={() => setIsOpen(!isOpen)}>
        <span className="wrd-accordion-title">{title}</span>
        <i className={`fas fa-chevron-${isOpen ? 'up' : 'down'} wrd-accordion-icon`} />
      </button>
      {isOpen && <div className="wrd-accordion-content">{children}</div>}
    </div>
  );
}

export function TeacherWritingResultDetailDrawer({
  testResultId,
  testId,
  testName,
  studentName,
  className,
  index,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: TeacherWritingResultDetailDrawerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promptUrl, setPromptUrl] = useState<string | null>(null);

  // Submission Data
  const [task1Content, setTask1Content] = useState('');
  const [task2Content, setTask2Content] = useState('');
  const [task1Score, setTask1Score] = useState<number | null>(null);
  const [task2Score, setTask2Score] = useState<number | null>(null);
  const [writingScore, setWritingScore] = useState<number | null>(null);
  const [comments, setComments] = useState('');
  const [feedbackFileName, setFeedbackFileName] = useState('');
  const [feedbackFileUrl, setFeedbackFileUrl] = useState('');
  const [submittedAt, setSubmittedAt] = useState<Date | null>(null);
  const [gradedAt, setGradedAt] = useState<Date | null>(null);
  const [gradedBy, setGradedBy] = useState('');
  const [status, setStatus] = useState('');

  const fetchCacheRef = useRef<Record<string, string | null>>({});

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const db = getFirestore(firebaseApp);

      // Step 1: Resolve testId.
      // Priority: testId prop → testResultId parsed from testId (for writing:/testResults:/attempts: prefixed IDs)
      let resolvedTestId = String(testId || '').trim();

      // If testResultId has a source prefix, try to resolve testId from that document first.
      // This handles cases where the writing submission document has a testId field.
      const separatorIndex = testResultId.indexOf(':');
      const hasPrefix = separatorIndex > 0;
      if (hasPrefix) {
        const source = testResultId.slice(0, separatorIndex);
        const rawId = testResultId.slice(separatorIndex + 1);

        // Try each collection to find the testId field
        const sourcesToTry: Array<{ coll: string; id: string }> = [
          { coll: 'writing', id: rawId },
          { coll: 'testResults', id: rawId },
          { coll: 'attempts', id: rawId },
        ];

        for (const { coll, id } of sourcesToTry) {
          if (resolvedTestId) break; // already resolved
          try {
            const snap = await getDoc(doc(db, coll, id));
            if (snap.exists()) {
              const data = snap.data() as Record<string, unknown>;
              const candidate = String(data.testId || '').trim();
              if (candidate) resolvedTestId = candidate;
            }
          } catch {
            // Try next source
          }
        }
      }

      if (!resolvedTestId) {
        setError('Test ID could not be determined. The test may have been deleted.');
        setLoading(false);
        return;
      }

      // Step 2: Fetch the test document to get prompt/file URLs.
      let testData: Record<string, unknown> | null = null;
      try {
        const testSnap = await getDoc(doc(db, 'tests', resolvedTestId));
        if (testSnap.exists()) {
          testData = testSnap.data() as Record<string, unknown>;
        }
      } catch (err) {
        console.warn('[TeacherWritingResultDetailDrawer] Could not fetch test doc:', err);
      }

      // Extract prompt URL from test data
      function collectStrings(value: unknown, output: string[], depth = 0): void {
        if (depth > 7 || value == null) return;
        if (typeof value === 'string') {
          const text = value.trim();
          if (text) output.push(text);
          return;
        }
        if (Array.isArray(value)) {
          value.forEach((item) => collectStrings(item, output, depth + 1));
          return;
        }
        if (typeof value === 'object') {
          Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, output, depth + 1));
        }
      }

      function isLikelyUrl(s: string): boolean {
        const t = s.trim().toLowerCase();
        return t.startsWith('http://') || t.startsWith('https://') || t.startsWith('gs://') || t.includes('/o/') || t.includes('%2f');
      }

      function isImageUrl(s: string): boolean {
        const t = s.trim().toLowerCase();
        return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/.test(t) || (isLikelyUrl(t) && t.includes('image'));
      }

      function extractPrompt(tData: Record<string, unknown>): string | null {
        const directUrl = tData.promptFileUrl || tData.testPromptUrl || tData.promptUrl;
        if (directUrl && typeof directUrl === 'string') return directUrl;

        const filesObj = tData.files;
        if (filesObj && typeof filesObj === 'object') {
          const f = filesObj as Record<string, unknown>;
          const allStrings: string[] = [];
          collectStrings(f.writingTask1, allStrings);
          collectStrings(f.writingTask2, allStrings);
          collectStrings(f.task1, allStrings);
          collectStrings(f.task2, allStrings);
          collectStrings(f.sourceDocument, allStrings);

          const imgUrl = allStrings.find((s) => isImageUrl(s));
          if (imgUrl) return imgUrl;
          const anyUrl = allStrings.find((s) => isLikelyUrl(s));
          if (anyUrl) return anyUrl;
        }

        const topStrings: string[] = [];
        collectStrings(tData.writingTask1, topStrings);
        collectStrings(tData.writingTask1Files, topStrings);
        collectStrings(tData.writingTask2, topStrings);
        collectStrings(tData.writingTask2Files, topStrings);

        const topImgUrl = topStrings.find((s) => isImageUrl(s));
        if (topImgUrl) return topImgUrl;
        const topAnyUrl = topStrings.find((s) => isLikelyUrl(s));
        if (topAnyUrl) return topAnyUrl;

        return null;
      }

      const url = testData ? extractPrompt(testData) : null;
      fetchCacheRef.current[resolvedTestId] = url;
      setPromptUrl(url);

      // Step 3: Fetch the submission document.
      let docData: any = null;

      if (hasPrefix) {
        const source = testResultId.slice(0, separatorIndex);
        const rawId = testResultId.slice(separatorIndex + 1);

        try {
          const snap = await getDoc(doc(db, source, rawId));
          if (snap.exists()) docData = snap.data();
        } catch (err) {
          console.warn('[TeacherWritingResultDetailDrawer] Could not fetch submission doc:', err);
        }
      }

      if (!docData) {
        // Fallback: try all three collections using rawId
        const rawId = hasPrefix ? testResultId.slice(separatorIndex + 1) : testResultId;
        const collections = ['writing', 'testResults', 'attempts'];
        for (const coll of collections) {
          try {
            const snap = await getDoc(doc(db, coll, rawId));
            if (snap.exists()) {
              docData = snap.data();
              break;
            }
          } catch {
            // Try next
          }
        }
      }

      if (!docData) {
        // No submission document found - show error but still display the prompt
        setError('Submission details not found. The student may not have submitted yet, or the record was removed.');
        setLoading(false);
        return;
      }

      const record = asRecord(docData);
      const answers = asRecord(record.answers);

      const t1 =
        pickText(answers, ['writingTask1', 'task1', 'task1Content', 'writing1']) ||
        pickText(record, ['writingTask1', 'task1', 'task1Content', 'writing1']);

      const t2 =
        pickText(answers, ['writingTask2', 'task2', 'task2Content', 'writing2']) ||
        pickText(record, ['writingTask2', 'task2', 'task2Content', 'writing2']);

      setTask1Content(t1);
      setTask2Content(t2);

      const statusVal = asText(record.status).toLowerCase();
      const isGraded = statusVal === 'graded' || (typeof record.writingScore === 'number' && Number.isFinite(record.writingScore));
      setStatus(isGraded ? 'graded' : 'pending');

      setTask1Score(typeof record.task1Score === 'number' ? record.task1Score : null);
      setTask2Score(typeof record.task2Score === 'number' ? record.task2Score : null);
      setWritingScore(typeof record.writingScore === 'number' ? record.writingScore : null);

      setComments(pickText(record, ['comments', 'feedback', 'writingFeedback']));
      setFeedbackFileName(asText(record.feedbackFileName));
      setFeedbackFileUrl(asText(record.feedbackFileUrl || record.feedbackUrl));

      const subAt = asDate(record.submittedAt ?? record.completedAt ?? record.startedAt);
      setSubmittedAt(subAt);
      setGradedAt(isGraded ? asDate(record.gradedAt, subAt) : null);
      setGradedBy(asText(record.gradedBy));
    } catch (err) {
      console.error('[TeacherWritingResultDetailDrawer]', err);
      setError('Failed to load writing test details.');
    } finally {
      setLoading(false);
    }
  }, [testResultId, testId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  // Keyboard navigation
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
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  const isPending = status === 'pending';

  return (
    <div className="wrd-drawer-overlay" onClick={onClose}>
      <div className="wrd-drawer" onClick={(e) => e.stopPropagation()}>
        
        {/* ── Header ─────────────────────────────────────── */}
        <div className="wrd-drawer-header">
          <div className="wrd-drawer-header-left">
            <button className="wrd-drawer-close" onClick={onClose} title="Close">
              <i className="fas fa-times" />
            </button>
            <div className="wrd-drawer-title-block">
              <span className="obj-drawer-num">#{index}</span>
              <h2 className="wrd-drawer-title">{testName}</h2>
              <span className="obj-drawer-student-meta">
                {studentName}
                {className && className !== 'No Class' ? ` — ${className}` : ''}
              </span>
            </div>
          </div>
          <div className="wrd-drawer-nav">
            <button className="wrd-nav-btn" onClick={onPrev} disabled={!hasPrev} title="Previous result">
              <i className="fas fa-chevron-left" />
            </button>
            <button className="wrd-nav-btn" onClick={onNext} disabled={!hasNext} title="Next result">
              <i className="fas fa-chevron-right" />
            </button>
          </div>
        </div>

        {/* ── Body ───────────────────────────────────────── */}
        <div className="wrd-drawer-content">
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
            <div className="wrd-grid">
              {/* Left Column: Prompt & Essay Submission */}
              <div className="wrd-col-left">
                <h2 className="wrd-title">{testName}</h2>

                {promptUrl && (
                  promptUrl.toLowerCase().includes('.pdf') ? (
                    <a href={promptUrl} target="_blank" rel="noopener noreferrer" className="wrd-file-link" style={{ marginBottom: '2rem' }}>
                      <i className="fas fa-file-pdf" />
                      <span>View Original Prompt PDF</span>
                      <i className="fas fa-external-link-alt" style={{ marginLeft: 'auto', fontSize: '0.8rem' }} />
                    </a>
                  ) : (
                    <div className="wrd-prompt-image-wrapper">
                      <div className="wrd-prompt-header">
                        <span className="wrd-ph-title"><i className="fas fa-image" /> Assignment Prompt</span>
                        <a href={promptUrl} target="_blank" rel="noopener noreferrer" className="wrd-ph-link">
                          Open Image <i className="fas fa-external-link-alt" />
                        </a>
                      </div>
                      <div className="wrd-prompt-img-scroll">
                        <img src={promptUrl} alt="Writing Prompt" className="wrd-prompt-img" />
                      </div>
                    </div>
                  )
                )}

                {!task1Content && !task2Content && (
                  <div className="wrd-empty-submission" style={{ marginBottom: '1.5rem' }}>
                    <i className="fas fa-pencil-alt" />
                    <p>No submission text found.</p>
                  </div>
                )}

                {task1Content && (
                  <Accordion title={<><i className="fas fa-pen-nib" /> Task 1 Submission</>} defaultOpen={true}>
                    <div className="wrd-submission-text">
                      {task1Content}
                    </div>
                  </Accordion>
                )}

                {task2Content && (
                  <Accordion title={<><i className="fas fa-pen-nib" /> Task 2 Submission</>} defaultOpen={true}>
                    <div className="wrd-submission-text">
                      {task2Content}
                    </div>
                  </Accordion>
                )}
              </div>

              {/* Right Column: Scoring, Status, and Feedback */}
              <div className="wrd-col-right sticky-sidebar">
                <div className="wrd-sidebar-section">
                  <h3 className="wrd-sidebar-title">Summary</h3>
                  <div className="wrd-score-card">
                    <div className="wrd-score-sub">
                      <div className="wrd-score-sub-item">
                        <span className="wrd-sc-label">Task 1</span>
                        <span className="wrd-sc-value">{isPending ? '—' : (task1Score ?? '—')}</span>
                      </div>
                      <div className="wrd-score-sub-item">
                        <span className="wrd-sc-label">Task 2</span>
                        <span className="wrd-sc-value">{isPending ? '—' : (task2Score ?? '—')}</span>
                      </div>
                    </div>
                    <div className="wrd-score-divider" />
                    <div className={`wrd-score-main ${isPending ? 'pending' : ''}`}>
                      <span className="wrd-sc-label">Overall Band</span>
                      <span className="wrd-sc-value">
                        {isPending ? 'Pending' : (typeof writingScore === 'number' ? writingScore.toFixed(1) : '—')}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="wrd-sidebar-section">
                  <h3 className="wrd-sidebar-title">Details</h3>
                  <div className="wrd-meta-list">
                    <div className="wrd-meta-item">
                      <span className="wrd-meta-label">Status</span>
                      <span className="wrd-meta-val">
                        <i className={isPending ? 'fas fa-clock wrd-status-icon' : 'fas fa-check-circle wrd-status-icon'} />
                        {isPending ? 'Pending' : 'Graded'}
                      </span>
                    </div>
                    <div className="wrd-meta-item">
                      <span className="wrd-meta-label">Submitted</span>
                      <span className="wrd-meta-val">{formatDate(submittedAt)}</span>
                    </div>
                    {!isPending && gradedAt && (
                      <div className="wrd-meta-item">
                        <span className="wrd-meta-label">Graded</span>
                        <span className="wrd-meta-val">{formatDate(gradedAt)}</span>
                      </div>
                    )}
                    {!isPending && gradedBy && (
                      <div className="wrd-meta-item">
                        <span className="wrd-meta-label">Grader</span>
                        <span className="wrd-meta-val">{gradedByDisplay(gradedBy)}</span>
                      </div>
                    )}
                  </div>
                </div>

                {comments && (
                  <div className="wrd-sidebar-section">
                    <h3 className="wrd-sidebar-title">Teacher Feedback Comments</h3>
                    <div className="wrd-feedback-text" style={{ whiteSpace: 'pre-wrap', color: 'var(--text-dark)' }}>
                      {comments}
                    </div>
                  </div>
                )}

                <div className="wrd-sidebar-section">
                  <h3 className="wrd-sidebar-title">Feedback File</h3>
                  {feedbackFileUrl ? (
                    <a href={feedbackFileUrl} target="_blank" rel="noopener noreferrer" className="wrd-file-link highlight compact">
                      <i className="fas fa-file-signature" />
                      <span>{feedbackFileName || 'Download Feedback File'}</span>
                      <i className="fas fa-download" style={{ marginLeft: 'auto', fontSize: '0.8rem' }} />
                    </a>
                  ) : (
                    <div className="wrd-no-feedback">
                      <i className="fas fa-file-circle-xmark" />
                      <span>No feedback file uploaded</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
