'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ExtractionLoadingPanel } from './extraction-loading-panel';
import { ReviewEditorPane } from './review-editor-pane';
import { SourceDocumentViewer } from './source-document-viewer';
import { useFileInputWithDragDrop } from '../hooks/use-file-input-with-drag-drop';
import { useUploadTestStore } from '../store/use-upload-test-store';
import {
  checkTestName,
  createTest,
  getClasses,
  uploadDraftFilesForCreate,
  uploadInlineImagesForCreate,
} from '../services/upload-test-api';
import type { ClassRecord } from '../services/upload-test-api';
import type {
  ExtractTestErrorResponse,
  ExtractTestResponse,
  TestPart,
  UploadFileBucket,
  TestSkill,
  UploadFileRef,
} from '../types';

const LISTENING_AUDIO_BUCKETS: Array<keyof UploadFileBucket> = [
  'listeningPart1',
  'listeningPart2',
  'listeningPart3',
  'listeningPart4',
];

type TestNameStatus = 'idle' | 'checking' | 'available' | 'duplicate' | 'error';
type AssignmentMode = 'all' | 'specific' | null;
type ListeningAnswerSheetQuestionType =
  | 'Multiple Choice Questions (Single Answer)'
  | 'Multiple Choice Questions (Choose Multiple)'
  | 'Sentence Completion & Summary Completion'
  | 'Form / Note / Table / Flow-chart / Map / Diagram / Summary Completion'
  | 'Matching (Info/Features/Sentence Halves)'
  | 'Short Answer Questions'
  | 'Pick from a List';

function hasNonEmptyText(value: unknown): boolean {
  return String(value || '').trim().length > 0;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim());
}

function isChooseMultipleType(typeLabel: string): boolean {
  return /multiple choice.*choose multiple/i.test(typeLabel);
}

function isSingleChoiceType(typeLabel: string): boolean {
  return /multiple choice.*single answer/i.test(typeLabel);
}

function isMatchingHeadingsType(typeLabel: string): boolean {
  return /matching headings/i.test(typeLabel);
}

function isMatchingSentenceEndingsType(typeLabel: string): boolean {
  return /matching sentence endings/i.test(typeLabel);
}

function isMatchingFeaturesType(typeLabel: string): boolean {
  return /matching features|pick from a list|matching \(info\/features\/sentence halves\)/i.test(typeLabel);
}

function isTrueFalseOrYesNoType(typeLabel: string): boolean {
  return /(true\s*\/\s*false\s*\/\s*not\s*given|yes\s*\/\s*no\s*\/\s*not\s*given)/i.test(typeLabel);
}

function splitListeningAnswerSheet(value: string): string[] {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  
  const answers = lines.map((line) => line.replace(/^\d+\s*[.)\-:]?\s*/, ''));
  
  console.log('[Listening] splitListeningAnswerSheet:', {
    inputLines: lines.length,
    outputAnswers: answers.length,
    firstFew: answers.slice(0, 5),
  });
  
  return answers;
}

function splitAnswerVariants(value: string): string[] {
  return String(value || '')
    .split(/\s*\/\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getListeningAnswerPatch(typeLabel: string, answer: string): Partial<Record<string, unknown>> {
  const raw = String(answer || '').trim();
  if (!raw) return {};

  console.log(`[Listening - getListeningAnswerPatch] Type: "${typeLabel}", Answer: "${raw.substring(0, 50)}..."`);

  if (/multiple choice.*choose multiple/i.test(typeLabel)) {
    const variants = splitAnswerVariants(raw).map((item) => item.toUpperCase());
    console.log(`  → Choose Multiple: ${variants.join(', ')}`);
    return {
      correctAnswers: variants,
    };
  }

  if (/multiple choice.*single answer/i.test(typeLabel) || isMatchingFeaturesType(typeLabel)) {
    const upper = raw.toUpperCase();
    console.log(`  → Single Choice/Features: ${upper}`);
    return { correctAnswer: upper };
  }

  if (isMatchingHeadingsType(typeLabel)) {
    const lower = raw.toLowerCase();
    console.log(`  → Matching Headings: ${lower}`);
    return {
      correctHeading: lower,
    };
  }

  if (isMatchingSentenceEndingsType(typeLabel)) {
    const upper = raw.toUpperCase();
    console.log(`  → Matching Sentence Endings: ${upper}`);
    return { correctEnding: upper };
  }

  if (isTrueFalseOrYesNoType(typeLabel)) {
    const upper = raw.toUpperCase();
    console.log(`  → True/False or Yes/No: ${upper}`);
    return { correctAnswer: upper };
  }

  console.log(`  → Default (Short Answer): ${raw}`);
  return { correctAnswer: raw };
}

function applyListeningAnswerSheetToParts(parts: TestPart[], answerSheet: string): TestPart[] {
  const answers = splitListeningAnswerSheet(answerSheet);
  if (answers.length === 0) {
    console.log('[Listening] No answers to apply');
    return parts;
  }

  let answerIndex = 0;
  let totalQuestions = 0;
  let appliedCount = 0;

  const result = parts.map((part, partIdx) => ({
    ...part,
    questionTypes: (part.questionTypes || []).map((questionType, qtIdx) => {
      const nextQuestions = (questionType.questions || []).map((question, qIdx) => {
        const answer = answers[answerIndex] || '';
        const currentIndex = answerIndex;
        answerIndex += 1;
        totalQuestions++;

        if (!answer) {
          console.log(
            `[Listening] Q${currentIndex + 1}: No answer available`,
            questionType.type,
          );
          return question;
        }

        const patch = getListeningAnswerPatch(questionType.type, answer);
        console.log(
          `[Listening] Q${currentIndex + 1}: Applied "${answer.substring(0, 40)}..." to type "${questionType.type}"`,
          patch,
        );
        appliedCount++;

        return {
          ...question,
          ...patch,
        };
      });

      return {
        ...questionType,
        questions: nextQuestions,
      };
    }),
  }));

  console.log(
    `[Listening] Summary: ${appliedCount}/${totalQuestions} questions auto-filled from ${answers.length} answers`,
  );

  return result;
}

function isQuestionTextOptionalType(typeLabel: string): boolean {
  return /completion|form|note|table|flow\-?chart|map|diagram|summary/i.test(typeLabel);
}

function isQuestionComplete(typeLabel: string, question: Record<string, unknown>): boolean {
  if (!isQuestionTextOptionalType(typeLabel) && !hasNonEmptyText(question.question)) {
    return false;
  }

  if (isChooseMultipleType(typeLabel)) {
    const options = toStringArray(question.options);
    if (options.length < 2 || options.some((option) => !option)) {
      return false;
    }

    const choiceCount = Math.max(Number(question.choiceCount || 0), 1);
    const validLetters = new Set(options.map((_, index) => String.fromCharCode(65 + index)));
    const correctAnswers = Array.from(
      new Set(
        toStringArray(question.correctAnswers)
          .map((answer) => answer.toUpperCase())
          .filter(Boolean),
      ),
    );

    return correctAnswers.length === choiceCount && correctAnswers.every((answer) => validLetters.has(answer));
  }

  if (isSingleChoiceType(typeLabel)) {
    const options = toStringArray(question.options);
    if (options.length < 2 || options.some((option) => !option)) {
      return false;
    }

    const validLetters = new Set(options.map((_, index) => String.fromCharCode(65 + index)));
    const correctAnswer = String(question.correctAnswer || '').trim().toUpperCase();

    return Boolean(correctAnswer) && validLetters.has(correctAnswer);
  }

  if (isMatchingHeadingsType(typeLabel)) {
    return hasNonEmptyText(question.paragraphLetter) && hasNonEmptyText(question.correctHeading);
  }

  if (isMatchingSentenceEndingsType(typeLabel)) {
    return hasNonEmptyText(question.correctEnding);
  }

  return hasNonEmptyText(question.correctAnswer);
}

function areAllQuestionGroupsComplete(parts: TestPart[]): boolean {
  if (!Array.isArray(parts) || parts.length === 0) {
    return false;
  }

  return parts.every((part) => {
    if (!Array.isArray(part.questionTypes) || part.questionTypes.length === 0) {
      return false;
    }

    return part.questionTypes.every((questionType) => {
      if (!Array.isArray(questionType.questions) || questionType.questions.length === 0) {
        return false;
      }

      return questionType.questions.every((question) => {
        const record = (question || {}) as Record<string, unknown>;
        return isQuestionComplete(questionType.type, record);
      });
    });
  });
}

function toUploadFileRef(file: File): UploadFileRef {
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    file,
  };
}

export function UploadTestWorkbench() {
  const router = useRouter();
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [writingTask1File, setWritingTask1File] = useState<File | null>(null);
  const [writingTask2File, setWritingTask2File] = useState<File | null>(null);
  const [listeningPart1File, setListeningPart1File] = useState<File | null>(null);
  const [listeningPart2File, setListeningPart2File] = useState<File | null>(null);
  const [listeningPart3File, setListeningPart3File] = useState<File | null>(null);
  const [listeningPart4File, setListeningPart4File] = useState<File | null>(null);
  const [listeningAnswerSheet, setListeningAnswerSheet] = useState('');
  const [submitStatus, setSubmitStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [submitMessage, setSubmitMessage] = useState('');
  const [testNameStatus, setTestNameStatus] = useState<TestNameStatus>('idle');
  const [testNameStatusMessage, setTestNameStatusMessage] = useState('Name must be unique across Test Hub.');
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>('all');
  const [availableClasses, setAvailableClasses] = useState<ClassRecord[]>([]);
  const [isClassesLoading, setIsClassesLoading] = useState(false);
  const [classesError, setClassesError] = useState('');
  const testNameCheckRequestRef = useRef(0);
  const AUTO_PAGE_RANGE = 'all';

  // Drag-drop handlers for source file
  const sourceDragDrop = useFileInputWithDragDrop({
    onFileSelect: onFileChange,
    acceptedTypes: ['.pdf', '.doc', '.docx', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/*'],
  });

  // Drag-drop handlers for writing task images
  const writingTask1DragDrop = useFileInputWithDragDrop({
    onFileSelect: (file) => onSkillAssetChange('writingTask1', file),
    acceptedTypes: ['image/*'],
  });

  const writingTask2DragDrop = useFileInputWithDragDrop({
    onFileSelect: (file) => onSkillAssetChange('writingTask2', file),
    acceptedTypes: ['image/*'],
  });

  // Drag-drop handlers for listening audio parts
  const listeningPart1DragDrop = useFileInputWithDragDrop({
    onFileSelect: (file) => onSkillAssetChange('listeningPart1', file),
    acceptedTypes: ['audio/*'],
  });

  const listeningPart2DragDrop = useFileInputWithDragDrop({
    onFileSelect: (file) => onSkillAssetChange('listeningPart2', file),
    acceptedTypes: ['audio/*'],
  });

  const listeningPart3DragDrop = useFileInputWithDragDrop({
    onFileSelect: (file) => onSkillAssetChange('listeningPart3', file),
    acceptedTypes: ['audio/*'],
  });

  const listeningPart4DragDrop = useFileInputWithDragDrop({
    onFileSelect: (file) => onSkillAssetChange('listeningPart4', file),
    acceptedTypes: ['audio/*'],
  });

  const draft = useUploadTestStore((state) => state.draft);
  const extraction = useUploadTestStore((state) => state.extraction);
  const answerKeyPreview = useUploadTestStore((state) => state.answerKeyPreview);
  const normalizedTestName = draft.testName.trim();

  const setSkill = useUploadTestStore((state) => state.setSkill);
  const setTestName = useUploadTestStore((state) => state.setTestName);
  const setDistribution = useUploadTestStore((state) => state.setDistribution);
  const setSelectedClasses = useUploadTestStore((state) => state.setSelectedClasses);
  const setFilesForBucket = useUploadTestStore((state) => state.setFilesForBucket);
  const setParts = useUploadTestStore((state) => state.setParts);
  const setExtractionLoading = useUploadTestStore((state) => state.setExtractionLoading);
  const setExtractionError = useUploadTestStore((state) => state.setExtractionError);
  const applyExtractionResult = useUploadTestStore((state) => state.applyExtractionResult);
  const buildCreateTestPayload = useUploadTestStore((state) => state.buildCreateTestPayload);
  const listeningAudioRefs = LISTENING_AUDIO_BUCKETS.map((bucket) => draft.files[bucket]?.[0] || null).filter(Boolean) as UploadFileRef[];
  const listeningSourceFile = draft.files.sourceDocument?.[0] || null;

  useEffect(() => {
    if (assignmentMode !== 'specific' || availableClasses.length > 0 || isClassesLoading) {
      return;
    }

    setIsClassesLoading(true);
    setClassesError('');

    void (async () => {
      try {
        const response = await getClasses();
        if (!response.success) {
          setClassesError('Unable to load classes right now.');
          return;
        }

        setAvailableClasses(response.classes || []);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to load classes right now.';
        setClassesError(message);
      } finally {
        setIsClassesLoading(false);
      }
    })();
  }, [assignmentMode, availableClasses.length, isClassesLoading]);

  useEffect(() => {
    if (!normalizedTestName) {
      testNameCheckRequestRef.current += 1;
      setTestNameStatus('idle');
      setTestNameStatusMessage('Name must be unique across Test Hub.');
      return;
    }

    const requestId = testNameCheckRequestRef.current + 1;
    testNameCheckRequestRef.current = requestId;
    setTestNameStatus('checking');
    setTestNameStatusMessage('Checking existing test names...');

    const timerId = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await checkTestName(normalizedTestName);
          if (testNameCheckRequestRef.current !== requestId) {
            return;
          }

          if (!response.success) {
            setTestNameStatus('error');
            setTestNameStatusMessage(response.message || 'Unable to verify test name right now.');
            return;
          }

          if (response.exists) {
            setTestNameStatus('duplicate');
            setTestNameStatusMessage('This test name already exists on Test Hub.');
            return;
          }

          setTestNameStatus('available');
          setTestNameStatusMessage('This test name is available.');
        } catch (error) {
          if (testNameCheckRequestRef.current !== requestId) {
            return;
          }

          const message =
            error instanceof Error && error.message
              ? error.message
              : 'Unable to verify test name right now.';
          setTestNameStatus('error');
          setTestNameStatusMessage(message);
        }
      })();
    }, 400);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [normalizedTestName]);

  const answerKeyCount = useMemo(() => Object.keys(answerKeyPreview).length, [answerKeyPreview]);
  const isSubmitDisabled = submitStatus === 'loading';
  const canExtractQuestions = draft.skill === 'reading' || draft.skill === 'listening';

  function applyAssignmentMode(nextMode: Exclude<AssignmentMode, null>) {
    if (nextMode === 'all') {
      if (assignmentMode === 'all') {
        setAssignmentMode(null);
        setDistribution('specific');
        setSelectedClasses([]);
        return;
      }

      setAssignmentMode('all');
      setDistribution('all');
      setSelectedClasses([]);
      return;
    }

    if (assignmentMode === 'specific') {
      setAssignmentMode(null);
      setDistribution('specific');
      setSelectedClasses([]);
      return;
    }

    setAssignmentMode('specific');
    setDistribution('specific');
  }

  function toggleClassSelection(classId: string) {
    const normalized = String(classId || '').trim();
    if (!normalized) return;

    const current = new Set(draft.classAssignment.selectedClasses);
    if (current.has(normalized)) {
      current.delete(normalized);
    } else {
      current.add(normalized);
    }

    setAssignmentMode('specific');
    setDistribution('specific');
    setSelectedClasses(Array.from(current));
  }

  async function runExtraction() {
    const skill = draft.skill;
    if (!skill || skill === 'writing') {
      setExtractionError('Extraction currently supports reading and listening only.');
      return;
    }

    if (!sourceFile) {
      setExtractionError('Please select a source PDF/image before extraction.');
      return;
    }

    setExtractionLoading(AUTO_PAGE_RANGE);

    try {
      const formData = new FormData();
      formData.append('skill', skill);
      formData.append('pageRange', AUTO_PAGE_RANGE);
      formData.append('file', sourceFile);

      const response = await fetch('/api/extract-test', {
        method: 'POST',
        body: formData,
      });

      const payload = (await response.json()) as ExtractTestResponse | ExtractTestErrorResponse;

      if (!response.ok || !payload.ok) {
        const errorMessage = payload.ok ? 'Extraction failed.' : payload.details || payload.error;
        setExtractionError(errorMessage);
        return;
      }

      const extractedPayload =
        draft.skill === 'listening' && hasNonEmptyText(listeningAnswerSheet)
          ? {
            ...payload.data,
            parts: applyListeningAnswerSheetToParts(payload.data.parts, listeningAnswerSheet),
          }
          : payload.data;

      applyExtractionResult(extractedPayload, AUTO_PAGE_RANGE);
    } catch (error) {
      setExtractionError(error instanceof Error ? error.message : 'Unexpected extraction error.');
    }
  }

  function onSkillChange(value: string) {
    if (value === 'reading' || value === 'listening' || value === 'writing') {
      const nextSkill = value as TestSkill;
      setSkill(nextSkill);

      if (nextSkill === 'reading') {
        if (sourceFile) {
          setFilesForBucket('reading', [toUploadFileRef(sourceFile)]);
        }
      } else {
        setFilesForBucket('reading', []);
      }

      if (nextSkill !== 'listening') {
        setListeningAnswerSheet('');
      }

      if (nextSkill !== 'writing') {
        setWritingTask1File(null);
        setWritingTask2File(null);
        setFilesForBucket('writingTask1', []);
        setFilesForBucket('writingTask2', []);
      }

      return;
    }

    setSkill(null);
    setFilesForBucket('reading', []);
    setWritingTask1File(null);
    setWritingTask2File(null);
    setFilesForBucket('writingTask1', []);
    setFilesForBucket('writingTask2', []);
  }

  function onFileChange(nextFile: File | null) {
    console.log('[Upload] onFileChange called:', nextFile ? { name: nextFile.name, type: nextFile.type } : null);
    setSourceFile(nextFile);

    if (!nextFile) {
      setFilesForBucket('sourceDocument', []);

      if (draft.skill === 'reading') {
        setFilesForBucket('reading', []);
      }

      return;
    }

    const fileRef = toUploadFileRef(nextFile);
    setFilesForBucket('sourceDocument', [fileRef]);

    if (draft.skill === 'reading') {
      setFilesForBucket('reading', [fileRef]);
    }
  }

  function onSkillAssetChange(bucket: keyof UploadFileBucket, nextFile: File | null) {
    console.log('[Upload] onSkillAssetChange called:', { bucket, file: nextFile ? { name: nextFile.name, type: nextFile.type } : null });
    
    // Update local state for display
    if (bucket === 'listeningPart1') {
      setListeningPart1File(nextFile);
    }
    if (bucket === 'listeningPart2') {
      setListeningPart2File(nextFile);
    }
    if (bucket === 'listeningPart3') {
      setListeningPart3File(nextFile);
    }
    if (bucket === 'listeningPart4') {
      setListeningPart4File(nextFile);
    }
    if (bucket === 'writingTask1') {
      setWritingTask1File(nextFile);
    }
    if (bucket === 'writingTask2') {
      setWritingTask2File(nextFile);
    }
    
    if (!nextFile) {
      setFilesForBucket(bucket, []);
      return;
    }

    setFilesForBucket(bucket, [toUploadFileRef(nextFile)]);
  }

  function onListeningAnswerSheetChange(value: string) {
    console.log('[Listening] onListeningAnswerSheetChange called with value length:', value.length);
    setListeningAnswerSheet(value);

    if (draft.skill !== 'listening') {
      console.log('[Listening] Skill is not listening, skipping auto-fill');
      return;
    }

    console.log('[Listening] Current parts count:', draft.parts.length, 'Total questions:', 
      draft.parts.reduce((sum, p) => sum + (p.questionTypes?.reduce((s, qt) => s + (qt.questions?.length || 0), 0) || 0), 0));

    if (draft.parts.length === 0) {
      console.log('[Listening] No extracted parts yet, answer sheet saved and will be auto-applied after extraction');
      return;
    }

    const nextParts = applyListeningAnswerSheetToParts(draft.parts, value);
    setParts(nextParts);
    console.log('[Listening] setParts called with updated parts');
  }

  async function handleSubmit() {
    if (submitStatus === 'loading') return;

    const skill = draft.skill;
    if (!skill) {
      setSubmitStatus('error');
      setSubmitMessage('Please select a test skill before submitting.');
      return;
    }

    const testName = normalizedTestName;
    if (!testName) {
      setSubmitStatus('error');
      setSubmitMessage('Please provide a test name before submitting.');
      return;
    }

    if ((skill === 'reading' || skill === 'listening') && draft.parts.length === 0) {
      setSubmitStatus('error');
      setSubmitMessage('No extracted questions found. Please run extraction first.');
      return;
    }

    if (skill === 'writing') {
      const hasTask1 = Boolean(draft.files.writingTask1?.[0]);
      const hasTask2 = Boolean(draft.files.writingTask2?.[0]);
      if (!hasTask1 || !hasTask2) {
        setSubmitStatus('error');
        setSubmitMessage('Please upload both writing task materials (Task 1 and Task 2).');
        return;
      }
    }

    setSubmitStatus('loading');
    setSubmitMessage('Uploading files and creating test...');

    try {
      const testNameCheck = await checkTestName(testName);
      if (!testNameCheck.success) {
        throw new Error(testNameCheck.message || 'Unable to verify test name uniqueness.');
      }

      if (testNameCheck.exists) {
        throw new Error('Test name already exists. Please choose a different name.');
      }

      const uploadedFiles = await uploadDraftFilesForCreate({
        skill,
        testName,
        files: draft.files,
      });

      const partsWithUploadedInlineImages = await uploadInlineImagesForCreate({
        testName,
        parts: draft.parts,
      });

      const finalPayload = buildCreateTestPayload(uploadedFiles, partsWithUploadedInlineImages);
      if (!finalPayload) {
        throw new Error('Unable to build final payload for createTest.');
      }

      console.log('[UploadTest] finalPayload before createTest:', finalPayload);
      console.log('[UploadTest] finalPayload JSON:', JSON.stringify(finalPayload, null, 2));

      const response = await createTest(finalPayload);

      setSubmitStatus('success');
      setSubmitMessage(`Test created successfully (ID: ${response.testId}). Redirecting...`);
      alert('Test created successfully!');

      window.setTimeout(() => {
        router.push('/teacher/tests');
      }, 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to submit test.';
      setSubmitStatus('error');
      setSubmitMessage(message);
      alert(`Failed to create test: ${message}`);
    }
  }

  const resultReady = draft.parts.length > 0;

  return (
    <section className="upload-workbench workbench-canvas">
      <div className="workbench-header">
        <span className="workbench-kicker">Authoring Studio</span>
        <h2 className="workbench-title">AI-Assisted Upload Test Editor</h2>
        <p className="workbench-subtitle">
          Extract with Gemini, then review and edit every part/question type/question before submit.
        </p>
      </div>

      <div className="workbench-controls">
        <div className="workbench-field-grid">
          <label className="workbench-field">
            <span className="field-label">Skill</span>
            <select
              value={draft.skill || ''}
              onChange={(event) => onSkillChange(event.target.value)}
              className="workbench-input"
            >
              <option value="">Select skill</option>
              <option value="reading">Reading</option>
              <option value="listening">Listening</option>
              <option value="writing">Writing</option>
            </select>
          </label>

          <label className="workbench-field">
            <span className="field-label">Test Name</span>
            <input
              value={draft.testName}
              onChange={(event) => setTestName(event.target.value)}
              placeholder="IELTS Reading Practice Test"
              className={`workbench-input ${
                testNameStatus === 'duplicate' || testNameStatus === 'error' ? 'workbench-input-invalid' : ''
              }`}
              aria-invalid={testNameStatus === 'duplicate' || testNameStatus === 'error'}
            />
            {normalizedTestName ? (
              <span
                className={`workbench-field-note ${
                  testNameStatus === 'available'
                    ? 'workbench-field-note-success'
                    : testNameStatus === 'duplicate' || testNameStatus === 'error'
                      ? 'workbench-field-note-error'
                      : ''
                }`}
              >
                {testNameStatusMessage}
              </span>
            ) : (
              <span className="workbench-field-note">Name must be unique across Test Hub.</span>
            )}
          </label>

          {draft.skill === 'writing' ? (
            <div className="workbench-writing-material-grid">
              <label className="workbench-field">
                <span className="field-label">Writing Task 1 Image</span>
                <div
                  ref={writingTask1DragDrop.zoneRef}
                  className={`workbench-file-drop-zone ${writingTask1DragDrop.isDragging ? 'is-dragging' : ''}`}
                  onDragEnter={writingTask1DragDrop.handleDragEnter}
                  onDragLeave={writingTask1DragDrop.handleDragLeave}
                  onDragOver={writingTask1DragDrop.handleDragOver}
                  onDrop={writingTask1DragDrop.handleDrop}
                >
                  <input
                    ref={writingTask1DragDrop.inputRef}
                    type="file"
                    accept="image/*"
                    onChange={(event) => { const file = event.target.files?.[0] || null; onSkillAssetChange('writingTask1', file); event.target.value = ''; }}
                    className="workbench-input workbench-file-input"
                  />
                  <div className="workbench-file-drop-hint">
                    <span className="workbench-file-drop-icon" aria-hidden="true">🖼️</span>
                    <span className="workbench-file-drop-text">
                      {writingTask1File ? (
                        <>🖼️ {writingTask1File.name}</>
                      ) : (
                        <>Drag Task 1 image or <button type="button" onClick={() => writingTask1DragDrop.trigger()} className="workbench-file-drop-link">browse</button> or paste</>
                      )}
                    </span>
                  </div>
                </div>
              </label>

              <label className="workbench-field">
                <span className="field-label">Writing Task 2 Image</span>
                <div
                  ref={writingTask2DragDrop.zoneRef}
                  className={`workbench-file-drop-zone ${writingTask2DragDrop.isDragging ? 'is-dragging' : ''}`}
                  onDragEnter={writingTask2DragDrop.handleDragEnter}
                  onDragLeave={writingTask2DragDrop.handleDragLeave}
                  onDragOver={writingTask2DragDrop.handleDragOver}
                  onDrop={writingTask2DragDrop.handleDrop}
                >
                  <input
                    ref={writingTask2DragDrop.inputRef}
                    type="file"
                    accept="image/*"
                    onChange={(event) => { const file = event.target.files?.[0] || null; onSkillAssetChange('writingTask2', file); event.target.value = ''; }}
                    className="workbench-input workbench-file-input"
                  />
                  <div className="workbench-file-drop-hint">
                    <span className="workbench-file-drop-icon" aria-hidden="true">🖼️</span>
                    <span className="workbench-file-drop-text">
                      {writingTask2File ? (
                        <>🖼️ {writingTask2File.name}</>
                      ) : (
                        <>Drag Task 2 image or <button type="button" onClick={() => writingTask2DragDrop.trigger()} className="workbench-file-drop-link">browse</button> or paste</>
                      )}
                    </span>
                  </div>
                </div>
              </label>
            </div>
          ) : (
            <label className="workbench-field">
              <span className="field-label">
                {draft.skill === 'reading'
                  ? 'Reading PDF / DOC / Image (Extraction + Submission)'
                  : draft.skill === 'listening'
                    ? 'Listening PDF / DOC / Image (Extraction only)'
                    : 'Source PDF / DOC / Image (Extraction)'}
              </span>
              <div
                ref={sourceDragDrop.zoneRef}
                className={`workbench-file-drop-zone ${sourceDragDrop.isDragging ? 'is-dragging' : ''}`}
                onDragEnter={sourceDragDrop.handleDragEnter}
                onDragLeave={sourceDragDrop.handleDragLeave}
                onDragOver={sourceDragDrop.handleDragOver}
                onDrop={sourceDragDrop.handleDrop}
              >
                <input
                  ref={sourceDragDrop.inputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
                  onChange={(event) => { const file = event.target.files?.[0] || null; onFileChange(file); event.target.value = ''; }}
                  className="workbench-input workbench-file-input"
                />
                <div className="workbench-file-drop-hint">
                  <span className="workbench-file-drop-icon" aria-hidden="true">📁</span>
                  <span className="workbench-file-drop-text">
                    {sourceFile ? (
                      <>📄 {sourceFile.name}</>
                    ) : (
                      <>Drag file here or <button type="button" onClick={() => sourceDragDrop.trigger()} className="workbench-file-drop-link">browse</button> or paste</>
                    )}
                  </span>
                </div>
              </div>
            </label>
          )}

          <div className="workbench-field workbench-assignment-field">
            <span className="field-label">Class Assignment</span>

            <div className="workbench-assignment-modes" aria-label="Class assignment mode">
              <button
                type="button"
                className={`workbench-assignment-chip ${assignmentMode === 'all' ? 'is-active' : ''}`}
                onClick={() => applyAssignmentMode('all')}
              >
                <span className="workbench-assignment-chip-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="workbench-assignment-chip-icon-svg">
                    <path d="M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0 -17 0" fill="none" stroke="currentColor" strokeWidth="1.7" />
                    <path d="M4.5 8.5h15M4.5 15.5h15M12 3.8c2.3 2.2 3.6 5 3.6 8.2s-1.3 6-3.6 8.2m0-16.4c-2.3 2.2-3.6 5-3.6 8.2s1.3 6 3.6 8.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </span>
                All classes
              </button>
              <button
                type="button"
                className={`workbench-assignment-chip ${assignmentMode === 'specific' ? 'is-active' : ''}`}
                onClick={() => applyAssignmentMode('specific')}
              >
                <span className="workbench-assignment-chip-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="workbench-assignment-chip-icon-svg">
                    <circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.7" />
                    <circle cx="16" cy="9" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.7" />
                    <path d="M4.7 17.8c.7-2.1 2.4-3.5 4.5-3.5s3.8 1.4 4.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    <path d="M13 18.2c.55-1.45 1.8-2.45 3.3-2.45c1.25 0 2.35.7 3.05 1.78" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </span>
                Specific classes
              </button>
            </div>

            {assignmentMode === 'specific' ? (
              <div className="workbench-class-picker">
                {isClassesLoading ? (
                  <p className="workbench-field-note">Loading classes...</p>
                ) : classesError ? (
                  <p className="workbench-field-note workbench-field-note-error">{classesError}</p>
                ) : availableClasses.length === 0 ? (
                  <p className="workbench-field-note">No classes found.</p>
                ) : (
                  <div className="workbench-class-chip-list">
                    {availableClasses.map((cls) => {
                      const classKey = String(cls.code || cls.id || '').trim();
                      if (!classKey) {
                        return null;
                      }

                      const selected = draft.classAssignment.selectedClasses.includes(classKey);

                      return (
                        <button
                          key={classKey}
                          type="button"
                          onClick={() => toggleClassSelection(classKey)}
                          className={`workbench-class-chip ${selected ? 'is-selected' : ''}`}
                        >
                          {cls.name || classKey}
                          {cls.code ? ` (${cls.code})` : ''}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            {assignmentMode !== 'all' && draft.classAssignment.selectedClasses.length === 0 ? (
              <p className="workbench-field-note">Locked mode: test is created but not assigned to any class yet.</p>
            ) : null}
          </div>

          {draft.skill === 'listening' ? (
            <div className="workbench-listening-panel">
              <div className="workbench-listening-audio-grid">
                <label className="workbench-field">
                  <span className="field-label">Listening Part 1 Audio</span>
                  <div
                    ref={listeningPart1DragDrop.zoneRef}
                    className={`workbench-file-drop-zone ${listeningPart1DragDrop.isDragging ? 'is-dragging' : ''}`}
                    onDragEnter={listeningPart1DragDrop.handleDragEnter}
                    onDragLeave={listeningPart1DragDrop.handleDragLeave}
                    onDragOver={listeningPart1DragDrop.handleDragOver}
                    onDrop={listeningPart1DragDrop.handleDrop}
                  >
                    <input
                      ref={listeningPart1DragDrop.inputRef}
                      type="file"
                      accept="audio/*"
                      onChange={(event) => { const file = event.target.files?.[0] || null; onSkillAssetChange('listeningPart1', file); event.target.value = ''; }}
                      className="workbench-input workbench-file-input"
                    />
                    <div className="workbench-file-drop-hint">
                      <span className="workbench-file-drop-icon" aria-hidden="true">🎵</span>
                      <span className="workbench-file-drop-text">
                        {listeningPart1File ? (
                          <>🎵 {listeningPart1File.name}</>
                        ) : (
                          <><button type="button" onClick={() => listeningPart1DragDrop.trigger()} className="workbench-file-drop-link">Browse</button> or drop audio</>
                        )}
                      </span>
                    </div>
                  </div>
                </label>

                <label className="workbench-field">
                  <span className="field-label">Listening Part 2 Audio</span>
                  <div
                    ref={listeningPart2DragDrop.zoneRef}
                    className={`workbench-file-drop-zone ${listeningPart2DragDrop.isDragging ? 'is-dragging' : ''}`}
                    onDragEnter={listeningPart2DragDrop.handleDragEnter}
                    onDragLeave={listeningPart2DragDrop.handleDragLeave}
                    onDragOver={listeningPart2DragDrop.handleDragOver}
                    onDrop={listeningPart2DragDrop.handleDrop}
                  >
                    <input
                      ref={listeningPart2DragDrop.inputRef}
                      type="file"
                      accept="audio/*"
                      onChange={(event) => { const file = event.target.files?.[0] || null; onSkillAssetChange('listeningPart2', file); event.target.value = ''; }}
                      className="workbench-input workbench-file-input"
                    />
                    <div className="workbench-file-drop-hint">
                      <span className="workbench-file-drop-icon" aria-hidden="true">🎵</span>
                      <span className="workbench-file-drop-text">
                        {listeningPart2File ? (
                          <>🎵 {listeningPart2File.name}</>
                        ) : (
                          <><button type="button" onClick={() => listeningPart2DragDrop.trigger()} className="workbench-file-drop-link">Browse</button> or drop audio</>
                        )}
                      </span>
                    </div>
                  </div>
                </label>

                <label className="workbench-field">
                  <span className="field-label">Listening Part 3 Audio</span>
                  <div
                    ref={listeningPart3DragDrop.zoneRef}
                    className={`workbench-file-drop-zone ${listeningPart3DragDrop.isDragging ? 'is-dragging' : ''}`}
                    onDragEnter={listeningPart3DragDrop.handleDragEnter}
                    onDragLeave={listeningPart3DragDrop.handleDragLeave}
                    onDragOver={listeningPart3DragDrop.handleDragOver}
                    onDrop={listeningPart3DragDrop.handleDrop}
                  >
                    <input
                      ref={listeningPart3DragDrop.inputRef}
                      type="file"
                      accept="audio/*"
                      onChange={(event) => { const file = event.target.files?.[0] || null; onSkillAssetChange('listeningPart3', file); event.target.value = ''; }}
                      className="workbench-input workbench-file-input"
                    />
                    <div className="workbench-file-drop-hint">
                      <span className="workbench-file-drop-icon" aria-hidden="true">🎵</span>
                      <span className="workbench-file-drop-text">
                        {listeningPart3File ? (
                          <>🎵 {listeningPart3File.name}</>
                        ) : (
                          <><button type="button" onClick={() => listeningPart3DragDrop.trigger()} className="workbench-file-drop-link">Browse</button> or drop audio</>
                        )}
                      </span>
                    </div>
                  </div>
                </label>

                <label className="workbench-field">
                  <span className="field-label">Listening Part 4 Audio</span>
                  <div
                    ref={listeningPart4DragDrop.zoneRef}
                    className={`workbench-file-drop-zone ${listeningPart4DragDrop.isDragging ? 'is-dragging' : ''}`}
                    onDragEnter={listeningPart4DragDrop.handleDragEnter}
                    onDragLeave={listeningPart4DragDrop.handleDragLeave}
                    onDragOver={listeningPart4DragDrop.handleDragOver}
                    onDrop={listeningPart4DragDrop.handleDrop}
                  >
                    <input
                      ref={listeningPart4DragDrop.inputRef}
                      type="file"
                      accept="audio/*"
                      onChange={(event) => { const file = event.target.files?.[0] || null; onSkillAssetChange('listeningPart4', file); event.target.value = ''; }}
                      className="workbench-input workbench-file-input"
                    />
                    <div className="workbench-file-drop-hint">
                      <span className="workbench-file-drop-icon" aria-hidden="true">🎵</span>
                      <span className="workbench-file-drop-text">
                        {listeningPart4File ? (
                          <>🎵 {listeningPart4File.name}</>
                        ) : (
                          <><button type="button" onClick={() => listeningPart4DragDrop.trigger()} className="workbench-file-drop-link">Browse</button> or drop audio</>
                        )}
                      </span>
                    </div>
                  </div>
                </label>
              </div>

              <label className="workbench-field workbench-listening-answer-sheet">
                <span className="field-label">Listening Answer Sheet</span>
                <textarea
                  value={listeningAnswerSheet}
                  onChange={(event) => onListeningAnswerSheetChange(event.target.value)}
                  className="workbench-input workbench-answer-sheet"
                  rows={8}
                  placeholder={`1. 30 March/30 March 1988
2. 0903775115
3. northern
4. train`}
                />
                <span className="workbench-field-note">
                  Paste the numbered answer list here. The questions in the right pane will auto-fill in order.
                  {listeningAnswerSheet.trim() && (
                    <>
                      {' | '}
                      <span style={{color: '#10b981'}}>
                        ✓ {listeningAnswerSheet.split('\n').filter(l => l.trim()).length} answers detected
                      </span>
                    </>
                  )}
                </span>
              </label>
            </div>
          ) : null}
        </div>

        <div className="workbench-action-panel">
          <div className="workbench-btn-row">
            {canExtractQuestions ? (
              <button
                type="button"
                className="workbench-btn workbench-btn-extract"
                onClick={runExtraction}
                disabled={extraction.status === 'loading'}
              >
                <span className="workbench-btn-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="workbench-btn-icon-svg">
                    <path
                      d="M6 3.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5A1.5 1.5 0 0 1 6.5 3.5z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path d="M14 3.5V8h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    <path d="M8 11.5h5M8 14.5h8M8 17.5h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <circle cx="18.5" cy="18.5" r="3.2" fill="#f0fdf4" stroke="currentColor" strokeWidth="1.4" />
                    <path d="M17.4 18.5h2.2M18.5 17.4v2.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </span>
                <span>{extraction.status === 'loading' ? 'Analyzing...' : 'Extract Questions'}</span>
              </button>
            ) : (
              <span className="workbench-pill">Writing mode: extraction is disabled.</span>
            )}

            <div className="workbench-submit-group">
              <button
                type="button"
                className="workbench-btn workbench-btn-solid"
                onClick={handleSubmit}
                disabled={isSubmitDisabled}
              >
                {submitStatus === 'loading' ? 'Submitting...' : 'Submit Test'}
              </button>
            </div>
          </div>

          <div className="workbench-pill-row">
            {canExtractQuestions ? (
              <span className="workbench-pill">
                Status: <strong className="workbench-pill-value">{extraction.status}</strong>
              </span>
            ) : null}
            <span className="workbench-pill">
              Parts: <strong className="workbench-pill-value">{draft.parts.length}</strong>
            </span>
            <span className="workbench-pill">
              Answer keys: <strong className="workbench-pill-value">{answerKeyCount}</strong>
            </span>
            {canExtractQuestions ? (
              <span className="workbench-pill">
                Warnings: <strong className="workbench-pill-value">{extraction.warnings.length}</strong>
              </span>
            ) : null}
          </div>

          <p className="workbench-helper-note">
            {canExtractQuestions
              ? 'Page range is automatic: all pages.'
              : 'Writing mode skips extraction. Upload Task 1 and Task 2 materials, then submit.'}
          </p>
        </div>
      </div>

      {extraction.errorMessage ? (
        <div className="workbench-alert workbench-alert-error">
          {extraction.errorMessage}
        </div>
      ) : null}

      {submitStatus !== 'idle' ? (
        <div
          className={`workbench-alert ${
            submitStatus === 'success'
              ? 'workbench-alert-success'
              : submitStatus === 'error'
                ? 'workbench-alert-error'
                : 'workbench-alert-loading'
          }`}
        >
          {submitMessage}
        </div>
      ) : null}

      {extraction.status === 'loading' ? <ExtractionLoadingPanel /> : null}

      {resultReady ? (
        <div className="workbench-stage-grid">
          <div className="workbench-stage-preview">
            <SourceDocumentViewer
              skill={draft.skill}
              sourceDocument={draft.skill === 'listening' ? listeningSourceFile : (draft.files.reading?.[0] || listeningSourceFile)}
              sourceFile={sourceFile}
              listeningAudioFiles={listeningAudioRefs}
            />
          </div>

          <ReviewEditorPane parts={draft.parts} skill={draft.skill} />
        </div>
      ) : extraction.status !== 'loading' ? (
        <div className="workbench-stage-grid">
          <div className="workbench-stage-preview">
            <SourceDocumentViewer
              skill={draft.skill}
              sourceDocument={draft.skill === 'listening' ? listeningSourceFile : (draft.files.reading?.[0] || listeningSourceFile)}
              sourceFile={sourceFile}
              listeningAudioFiles={listeningAudioRefs}
            />
          </div>

          <div className="workbench-empty-editor">
            <h3>Editor Workspace</h3>
            <p>Extraction result will be rendered here as an editable Part → QuestionType → Question tree.</p>
          </div>
        </div>
      ) : null}

      {extraction.warnings.length > 0 ? (
        <div className="workbench-warning-panel">
          <h3 className="workbench-warning-title">Extraction Warnings</h3>
          <ul className="workbench-warning-list">
            {extraction.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`}>
                <strong>{warning.code}</strong>: {warning.message}
                {warning.path ? ` (${warning.path})` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {submitStatus === 'loading' ? (
        <div className="workbench-overlay">
          <div className="workbench-overlay-card">
            <div className="workbench-overlay-spinner" />
            <p>Uploading media and creating test...</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
