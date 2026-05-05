'use client';

import { useEffect, useState } from 'react';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { firebaseApp } from '@/services/firebase';
import { resolveMaterialUrl } from '@/services/resolve-material';
import type { WritingResult } from '@/services/student-writing-results';

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  result: WritingResult | null;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

function formatDate(d: Date | undefined): string {
  if (!d) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function gradedByDisplay(raw?: string): string {
  if (!raw) return 'Unknown';
  if (raw.includes('vulananh957') || raw.includes('hanh')) return 'Ms. Hanh Le';
  return raw;
}

function Accordion({ title, defaultOpen = false, children }: { title: React.ReactNode, defaultOpen?: boolean, children: React.ReactNode }) {
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

export function WritingResultDrawer({ isOpen, onClose, result, onPrev, onNext, hasPrev, hasNext }: DrawerProps) {
  const [fetchedPromptUrl, setFetchedPromptUrl] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  useEffect(() => {
    if (!result) {
      setFetchedPromptUrl(null);
      return;
    }
    const currentResult = result;
    
    // If result already has a promptFileUrl, no need to fetch from test doc
    if (currentResult.promptFileUrl) {
      return;
    }
    
    let isMounted = true;
    const db = getFirestore(firebaseApp);
    
    // Recursively collect all string values from a nested structure
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
    
    function extractPromptFromTestData(testData: Record<string, unknown>): string | null {
      // Direct prompt URL fields
      const directUrl = testData.promptFileUrl || testData.testPromptUrl || testData.promptUrl;
      if (directUrl && typeof directUrl === 'string') return directUrl;
      
      // Extract from files bucket
      const files = testData.files;
      if (files && typeof files === 'object') {
        const f = files as Record<string, unknown>;
        const allStrings: string[] = [];
        collectStrings(f.writingTask1, allStrings);
        collectStrings(f.writingTask2, allStrings);
        collectStrings(f.task1, allStrings);
        collectStrings(f.task2, allStrings);
        collectStrings(f.sourceDocument, allStrings);
        
        const imageUrl = allStrings.find((s) => isImageUrl(s));
        if (imageUrl) return imageUrl;
        const anyUrl = allStrings.find((s) => isLikelyUrl(s));
        if (anyUrl) return anyUrl;
      }
      
      // Top-level fields
      const topStrings: string[] = [];
      collectStrings(testData.writingTask1, topStrings);
      collectStrings(testData.writingTask1Files, topStrings);
      collectStrings(testData.writingTask2, topStrings);
      collectStrings(testData.writingTask2Files, topStrings);
      
      const topImageUrl = topStrings.find((s) => isImageUrl(s));
      if (topImageUrl) return topImageUrl;
      const topAnyUrl = topStrings.find((s) => isLikelyUrl(s));
      if (topAnyUrl) return topAnyUrl;
      
      return null;
    }
    
    async function fetchPrompt() {
      // Strategy 1: Lookup by testId (document ID)
      if (currentResult.testId) {
        try {
          const snap = await getDoc(doc(db, 'tests', currentResult.testId));
          if (snap.exists()) {
            const url = extractPromptFromTestData(snap.data() as Record<string, unknown>);
            const resolved = url ? await resolveMaterialUrl(url) : null;
            console.log('[PROMPT] Found test by ID, url:', resolved);
            if (isMounted) setFetchedPromptUrl(resolved);
            return;
          }
          console.log('[PROMPT] Test doc not found by ID:', currentResult.testId, '→ trying name fallback');
        } catch (err) {
          console.warn('[PROMPT] Error fetching by ID:', err);
        }
      }
      
      // Strategy 2: Query by test name (fallback for deleted/migrated tests)
      if (currentResult.testName) {
        try {
          const { collection: col, query: q, where: w, getDocs: gd } = await import('firebase/firestore');
          const nameQuery = q(col(db, 'tests'), w('name', '==', currentResult.testName));
          const snapshot = await gd(nameQuery);
          
          if (!snapshot.empty) {
            // Try each matching test doc
            for (const testDoc of snapshot.docs) {
              const testData = testDoc.data() as Record<string, unknown>;
              if (testData.skill === 'writing') {
                const url = extractPromptFromTestData(testData);
                const resolved = url ? await resolveMaterialUrl(url) : null;
                console.log('[PROMPT] Found test by name, url:', resolved);
                if (isMounted) setFetchedPromptUrl(resolved);
                return;
              }
            }
            // If no writing-skill match, try any match
            const url = extractPromptFromTestData(snapshot.docs[0].data() as Record<string, unknown>);
            const resolved = url ? await resolveMaterialUrl(url) : null;
            console.log('[PROMPT] Found test by name (any skill), url:', resolved);
            if (isMounted) setFetchedPromptUrl(resolved);
            return;
          }
          console.log('[PROMPT] No test found by name either:', currentResult.testName);
        } catch (err) {
          console.warn('[PROMPT] Error querying by name:', err);
        }
      }
      
      if (isMounted) setFetchedPromptUrl(null);
    }
    
    fetchPrompt();
      
    return () => {
      isMounted = false;
    };
  }, [result]);

  if (!isOpen || !result) return null;

  const isPending = result.writingScore === 'Pending';
  const effectivePromptUrl = result.promptFileUrl || fetchedPromptUrl;

  return (
    <div className="wrd-drawer-overlay" onClick={onClose}>
      <div className="wrd-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="wrd-drawer-header">
          <div className="wrd-drawer-header-inner">
            <div className="wrd-drawer-nav">
              <button className="wrd-icon-btn" onClick={onPrev} disabled={!hasPrev} title="Previous">
                <i className="fas fa-chevron-left" />
              </button>
              <button className="wrd-icon-btn" onClick={onNext} disabled={!hasNext} title="Next">
                <i className="fas fa-chevron-right" />
              </button>
            </div>
            <button className="wrd-close-btn" onClick={onClose} title="Close">
              <i className="fas fa-times" />
            </button>
          </div>
        </div>

        <div className="wrd-drawer-content wrd-grid">
          {/* Left Column: Reading Content */}
          <div className="wrd-col-left">
            <h2 className="wrd-title">{result.testName}</h2>

            {effectivePromptUrl && (
              effectivePromptUrl.toLowerCase().includes('.pdf') ? (
                <a href={effectivePromptUrl} target="_blank" rel="noopener noreferrer" className="wrd-file-link" style={{ marginBottom: '2rem' }}>
                  <i className="fas fa-file-pdf" />
                  <span>View Original Prompt PDF</span>
                  <i className="fas fa-external-link-alt" style={{ marginLeft: 'auto', fontSize: '0.8rem' }} />
                </a>
              ) : (
                <div className="wrd-prompt-image-wrapper">
                  <div className="wrd-prompt-header">
                    <span className="wrd-ph-title"><i className="fas fa-image" /> Assignment Prompt</span>
                    <a href={effectivePromptUrl} target="_blank" rel="noopener noreferrer" className="wrd-ph-link">
                      Open Image <i className="fas fa-external-link-alt" />
                    </a>
                  </div>
                  <div className="wrd-prompt-img-scroll">
                    <img src={effectivePromptUrl} alt="Writing Prompt" className="wrd-prompt-img" />
                  </div>
                </div>
              )
            )}

            {!result.task1Submission && !result.task2Submission && (
              <div className="wrd-empty-submission" style={{ marginBottom: '1.5rem' }}>
                <i className="fas fa-pencil-alt" />
                <p>No submission text found.</p>
              </div>
            )}

            {result.task1Submission && (
              <Accordion title={<><i className="fas fa-pen-nib" /> Task 1 Submission</>} defaultOpen={true}>
                <div className="wrd-submission-text">
                  {result.task1Submission}
                </div>
              </Accordion>
            )}

            {result.task2Submission && (
              <Accordion title={<><i className="fas fa-pen-nib" /> Task 2 Submission</>} defaultOpen={true}>
                <div className="wrd-submission-text">
                  {result.task2Submission}
                </div>
              </Accordion>
            )}


          </div>

          {/* Right Column: Sticky Summary */}
          <div className="wrd-col-right sticky-sidebar">
            <div className="wrd-sidebar-section">
              <h3 className="wrd-sidebar-title">Summary</h3>
              <div className="wrd-score-card">
                <div className="wrd-score-sub">
                  <div className="wrd-score-sub-item">
                    <span className="wrd-sc-label">Task 1</span>
                    <span className="wrd-sc-value">{isPending ? '—' : (result.task1Score ?? '—')}</span>
                  </div>
                  <div className="wrd-score-sub-item">
                    <span className="wrd-sc-label">Task 2</span>
                    <span className="wrd-sc-value">{isPending ? '—' : (result.task2Score ?? '—')}</span>
                  </div>
                </div>
                <div className="wrd-score-divider" />
                <div className={`wrd-score-main ${isPending ? 'pending' : ''}`}>
                  <span className="wrd-sc-label">Overall Band</span>
                  <span className="wrd-sc-value">{isPending ? 'Pending' : (typeof result.writingScore === 'number' ? result.writingScore.toFixed(1) : '—')}</span>
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
                  <span className="wrd-meta-val">{formatDate(result.submittedAt)}</span>
                </div>
                {!isPending && result.gradedAt && (
                  <div className="wrd-meta-item">
                    <span className="wrd-meta-label">Graded</span>
                    <span className="wrd-meta-val">{formatDate(result.gradedAt)}</span>
                  </div>
                )}
                {!isPending && result.gradedBy && (
                  <div className="wrd-meta-item">
                    <span className="wrd-meta-label">Grader</span>
                    <span className="wrd-meta-val">{gradedByDisplay(result.gradedBy)}</span>
                  </div>
                )}
              </div>
            </div>

            {result.feedbackFileUrl && (
              <div className="wrd-sidebar-section">
                <a href={result.feedbackFileUrl} target="_blank" rel="noopener noreferrer" className="wrd-file-link highlight compact">
                  <i className="fas fa-file-signature" />
                  <span>Download Feedback</span>
                  <i className="fas fa-download" style={{ marginLeft: 'auto', fontSize: '0.8rem' }} />
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
