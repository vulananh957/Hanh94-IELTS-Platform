'use client';

import { useMemo, useState } from 'react';
import { useUploadTestStore } from '../store/use-upload-test-store';
import { ReviewEditorPane } from './review-editor-pane';
import { SourceDocumentViewer } from './source-document-viewer';
import { useFileInputWithDragDrop } from '../hooks/use-file-input-with-drag-drop';
import { uploadInlineImagesForEdit, updateTest } from '../services/edit-test-api';
import { uploadDraftFilesForCreate } from '../services/upload-test-api';
import type { UploadFileRef } from '../types';

type SubmitStatus = 'idle' | 'loading' | 'success' | 'error';

interface EditTestWorkbenchProps {
  testId: string;
  onClose: () => void;
}

function toUploadFileRef(file: File): UploadFileRef {
  return { name: file.name, type: file.type, size: file.size, file };
}

export function EditTestWorkbench({ testId, onClose }: EditTestWorkbenchProps) {
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle');
  const [submitMessage, setSubmitMessage] = useState('');

  // Source file selected by the user (for reading tests)
  const [sourceFile, setSourceFile] = useState<File | null>(null);

  // File state for listening audio (4 parts) — used when user selects new files
  const [listeningPart1File, setListeningPart1File] = useState<File | null>(null);
  const [listeningPart2File, setListeningPart2File] = useState<File | null>(null);
  const [listeningPart3File, setListeningPart3File] = useState<File | null>(null);
  const [listeningPart4File, setListeningPart4File] = useState<File | null>(null);

  const draft = useUploadTestStore((s) => s.draft);
  const answerKeyPreview = useUploadTestStore((s) => s.answerKeyPreview);
  const isEditMode = useUploadTestStore((s) => s.isEditMode);
  const editingTestId = useUploadTestStore((s) => s.editingTestId);
  const setFilesForBucket = useUploadTestStore((s) => s.setFilesForBucket);

  const answerKeyCount = useMemo(() => Object.keys(answerKeyPreview).length, [answerKeyPreview]);
  const normalizedTestName = draft.testName.trim();
  const resultReady = draft.parts.length > 0;

  // Derived listening audio refs: merge store files + newly selected files
  const listeningAudioRefs = useMemo<UploadFileRef[]>(() => {
    const refs: UploadFileRef[] = [];

    // Existing uploaded files from the store (listeningPart1–4 buckets)
    const storeParts = [
      draft.files.listeningPart1,
      draft.files.listeningPart2,
      draft.files.listeningPart3,
      draft.files.listeningPart4,
    ];
    for (const part of storeParts) {
      if (part && part.length > 0) refs.push(part[0]);
    }

    // New locally selected files take priority over store files (replace on save)
    if (listeningPart1File) refs.push(toUploadFileRef(listeningPart1File));
    if (listeningPart2File) refs.push(toUploadFileRef(listeningPart2File));
    if (listeningPart3File) refs.push(toUploadFileRef(listeningPart3File));
    if (listeningPart4File) refs.push(toUploadFileRef(listeningPart4File));

    return refs;
  }, [draft.files, listeningPart1File, listeningPart2File, listeningPart3File, listeningPart4File]);

  // Drag-drop: source file (reading only)
  const sourceDragDrop = useFileInputWithDragDrop({
    onFileSelect: (file) => {
      setSourceFile(file);
      if (file) {
        const ref = toUploadFileRef(file);
        setFilesForBucket('sourceDocument', [ref]);
        if (draft.skill === 'reading') setFilesForBucket('reading', [ref]);
      } else {
        setFilesForBucket('sourceDocument', []);
        if (draft.skill === 'reading') setFilesForBucket('reading', []);
      }
    },
    acceptedTypes: ['.pdf', '.doc', '.docx', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/*'],
  });

  async function handleSave() {
    if (submitStatus === 'loading') return;

    const skill = draft.skill;
    if (!skill || (skill !== 'reading' && skill !== 'listening')) {
      setSubmitStatus('error');
      setSubmitMessage('Only reading and listening tests can be edited.');
      return;
    }

    if (!normalizedTestName) {
      setSubmitStatus('error');
      setSubmitMessage('Test name is required.');
      return;
    }

    if (draft.parts.length === 0) {
      setSubmitStatus('error');
      setSubmitMessage('No questions found. Add at least one part and question.');
      return;
    }

    setSubmitStatus('loading');
    setSubmitMessage('Saving changes…');

    try {
      // 1. Upload inline images (new data URLs only; remote URLs preserved)
      const partsWithUploadedImages = await uploadInlineImagesForEdit({
        testId,
        testName: normalizedTestName,
        parts: draft.parts,
      });

      // 2. Upload skill files (reading PDF or listening audio)
      const uploadedFiles = await uploadDraftFilesForCreate({
        skill,
        testName: normalizedTestName,
        files: draft.files,
      });

      // 3. Call updateTest API
      const response = await updateTest({
        testId,
        testName: normalizedTestName,
        skill,
        metadata: { parts: partsWithUploadedImages },
        files: uploadedFiles,
        classAssignment: draft.classAssignment,
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to save changes.');
      }

      setSubmitStatus('success');
      setSubmitMessage(
        response.recalculatedCount > 0
          ? `Saved! Recalculated scores for ${response.recalculatedCount} student(s).`
          : 'Changes saved successfully.',
      );

      setTimeout(() => { onClose(); }, 1500);
    } catch (err) {
      setSubmitStatus('error');
      setSubmitMessage(err instanceof Error ? err.message : 'Failed to save changes.');
    }
  }

  function handleSubmitWithConfirm() {
    const confirmed = window.confirm(
      'This test may have students who already took it. Saving will recalculate their scores based on updated answers. Continue?',
    );
    if (!confirmed) return;
    void handleSave();
  }

  if (!isEditMode || editingTestId !== testId) return null;

  return (
    <section className="upload-workbench workbench-canvas">
      {/* Header */}
      <div className="workbench-header">
        <div className="workbench-header-back">
          <button type="button" onClick={onClose} className="workbench-back-btn">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back
          </button>
        </div>
        <div className="workbench-header-content">
          <h1>Edit Test</h1>
          <p>Manage and update test content, audio files, and answer keys</p>
        </div>
      </div>

      <div className="workbench-controls">
        <div className="workbench-test-name-line">
          <span className="workbench-test-name-label">Test Name:</span>
          <span className="workbench-test-name-value">{draft.testName || '—'}</span>
        </div>

        <div className="workbench-field-grid">
        </div>

        {/* Action panel */}
        <div className="workbench-action-panel">
          <div className="workbench-btn-row">
            <div className="workbench-pill-row">
              <span className="workbench-pill">
                Parts: <strong className="workbench-pill-value">{draft.parts.length}</strong>
              </span>
              <span className="workbench-pill">
                Answer keys: <strong className="workbench-pill-value">{answerKeyCount}</strong>
              </span>
              <span className="workbench-pill">
                Skill: <strong className="workbench-pill-value" style={{ textTransform: 'capitalize' }}>{draft.skill}</strong>
              </span>
            </div>
            <button
              type="button"
              className="workbench-btn workbench-btn-solid workbench-btn-submit"
              onClick={handleSubmitWithConfirm}
              disabled={submitStatus === 'loading'}
            >
              <span className="workbench-submit-label">
                {submitStatus === 'loading' ? 'Saving…' : 'Save Changes'}
              </span>
            </button>
          </div>
        </div>
      </div>

      {submitStatus !== 'idle' ? (
        <div className={`workbench-alert ${
          submitStatus === 'success' ? 'workbench-alert-success' :
          submitStatus === 'error' ? 'workbench-alert-error' : 'workbench-alert-loading'
        }`}>
          {submitMessage}
        </div>
      ) : null}

      {/* Review & Edit Panel */}
      {resultReady ? (
        <div className="workbench-stage-grid">
          <div className="workbench-stage-preview">
            <SourceDocumentViewer
              skill={draft.skill}
              sourceDocument={draft.skill === 'listening' ? null : (draft.files.reading?.[0] ?? draft.files.sourceDocument?.[0] ?? null)}
              sourceFile={sourceFile}
              listeningAudioFiles={listeningAudioRefs}
            />
          </div>

          <ReviewEditorPane parts={draft.parts} skill={draft.skill} />
        </div>
      ) : (
        <div className="workbench-stage-grid">
          <div className="workbench-stage-preview">
            <SourceDocumentViewer
              skill={draft.skill}
              sourceDocument={draft.skill === 'listening' ? null : (draft.files.reading?.[0] ?? draft.files.sourceDocument?.[0] ?? null)}
              sourceFile={sourceFile}
              listeningAudioFiles={listeningAudioRefs}
            />
          </div>

          <div className="workbench-empty-editor">
            <h3>Editor Workspace</h3>
            <p>No questions loaded. The test questions will appear here once loaded from the existing test data.</p>
          </div>
        </div>
      )}
    </section>
  );
}
