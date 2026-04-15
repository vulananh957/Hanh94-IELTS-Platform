'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import { getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';
import { firebaseApp } from '@/services/firebase';
import { useFileInputWithDragDrop } from '@/features/upload-test/hooks/use-file-input-with-drag-drop';
import {
  getManualGradingSubmissions,
  invalidateManualGradingCache,
  submitManualGrade,
  type ManualGradingSubmission,
} from '@/services/manual-grading';
import '../teacher-dashboard.css';
import './manual-grading.css';

type TeacherUser = {
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
};

function formatDateTime(value: Date | null): string {
  if (!value) return '-';
  return value.toLocaleString('en-US');
}

function toSafeBand(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(9, Math.round(value * 10) / 10));
}

function getStudentInitials(submission: ManualGradingSubmission): string {
  const source = submission.studentName || submission.studentEmail || 'S';
  return source
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function buildWordCompatibleDocument(submission: ManualGradingSubmission): string {
  const submittedDate = submission.submittedAt ? submission.submittedAt.toLocaleString('en-US') : 'N/A';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${submission.testName || 'Writing Test'}</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.6; margin: 24px; }
    h1, h2, h3 { color: #0f766e; }
    .meta { margin-bottom: 16px; }
    .task { margin-top: 20px; border: 1px solid #d1d5db; padding: 14px; border-radius: 8px; }
    pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 12pt; margin: 0; }
  </style>
</head>
<body>
  <h1>${submission.testName || 'Writing Test'}</h1>
  <div class="meta">
    <h2>Student Information</h2>
    <p><strong>Name:</strong> ${submission.studentName || 'Student'}</p>
    <p><strong>Email:</strong> ${submission.studentEmail || 'N/A'}</p>
    <p><strong>Class:</strong> ${submission.classCode || 'N/A'}</p>
    <p><strong>Submission Date:</strong> ${submittedDate}</p>
  </div>
  <div class="task">
    <h3>Task 1: Academic Writing</h3>
    <pre>${submission.task1Content || 'No content'}</pre>
  </div>
  <div class="task">
    <h3>Task 2: Essay Writing</h3>
    <pre>${submission.task2Content || 'No content'}</pre>
  </div>
</body>
</html>`;
}

export function ManualGradingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sidebarRef = useRef<HTMLElement | null>(null);
  const loadSeqRef = useRef(0);
  const autoOpenFromQueryRef = useRef(false);

  const [auth, setAuth] = useState<ReturnType<typeof getAuth> | null>(null);
  const [user, setUser] = useState<TeacherUser | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<ManualGradingSubmission[]>([]);
  const [searchText, setSearchText] = useState('');
  const [selectedClass, setSelectedClass] = useState('all');
  const [selectedTest, setSelectedTest] = useState('all');

  const [selected, setSelected] = useState<ManualGradingSubmission | null>(null);
  const [task1Score, setTask1Score] = useState<number>(0);
  const [task2Score, setTask2Score] = useState<number>(0);
  const [comments, setComments] = useState('');
  const [feedbackFile, setFeedbackFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setAuth(getAuth(firebaseApp));
  }, []);

  useEffect(() => {
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) {
        router.push('/login');
        return;
      }
      setUser(currentUser);
    });
    return () => unsub();
  }, [auth, router]);

  const loadSubmissions = async (forceRefresh = false) => {
    if (!user?.email) return;

    const sequence = ++loadSeqRef.current;
    if (forceRefresh) {
      setIsRefreshing(true);
      invalidateManualGradingCache(user.email);
    } else {
      setIsLoading(true);
    }

    try {
      setError(null);
      const rows = await getManualGradingSubmissions(user.email, forceRefresh);
      if (sequence !== loadSeqRef.current) return;
      setSubmissions(rows);
    } catch (err) {
      if (sequence !== loadSeqRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load manual grading submissions.');
    } finally {
      if (sequence === loadSeqRef.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  };

  useEffect(() => {
    if (!user?.email) return;
    loadSubmissions(false);
  }, [user?.email]);

  useEffect(() => {
    if (!sidebarOpen) return;

    const onDocClick = (event: MouseEvent) => {
      const node = sidebarRef.current;
      const target = event.target as Node | null;
      if (!node || !target) return;
      if (!node.contains(target)) {
        setSidebarOpen(false);
      }
    };

    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen) return;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;

    const onMouseMove = (event: MouseEvent) => {
      const node = sidebarRef.current;
      const hoveringSidebar = !!node && node.matches(':hover');

      if (!hoveringSidebar && event.clientX > 340) {
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = setTimeout(() => setSidebarOpen(false), 120);
      } else if (closeTimer) {
        clearTimeout(closeTimer);
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    return () => {
      if (closeTimer) clearTimeout(closeTimer);
      document.removeEventListener('mousemove', onMouseMove);
    };
  }, [sidebarOpen]);

  const pendingRows = useMemo(
    () => submissions.filter((row) => String(row.status).toLowerCase() === 'pending'),
    [submissions],
  );

  const openMode = (searchParams.get('open') || '').trim().toLowerCase();
  const filterStudent = (searchParams.get('student') || '').trim().toLowerCase();
  const filterTestId = (searchParams.get('testId') || '').trim();
  const filterTest = (searchParams.get('test') || '').trim().toLowerCase();

  const classOptions = useMemo(() => {
    return Array.from(new Set(
      pendingRows
        .map((row) => (row.classCode || '').trim())
        .filter(Boolean),
    )).sort((a, b) => a.localeCompare(b));
  }, [pendingRows]);

  const testOptions = useMemo(() => {
    return Array.from(new Set(
      pendingRows
        .map((row) => (row.testName || '').trim())
        .filter(Boolean),
    )).sort((a, b) => a.localeCompare(b));
  }, [pendingRows]);

  const visibleRows = useMemo(() => {
    const search = searchText.trim().toLowerCase();

    return pendingRows.filter((row) => {
      const studentMatch = !filterStudent
        || row.studentEmail.toLowerCase().includes(filterStudent)
        || row.studentName.toLowerCase().includes(filterStudent);
      const testIdMatch = !filterTestId || row.testId === filterTestId;
      const testParamMatch = !filterTest || row.testName.toLowerCase().includes(filterTest);

      const textMatch = !search
        || row.studentName.toLowerCase().includes(search)
        || row.studentEmail.toLowerCase().includes(search)
        || row.testName.toLowerCase().includes(search)
        || (row.classCode || '').toLowerCase().includes(search);

      const classMatch = selectedClass === 'all' || row.classCode === selectedClass;
      const testMatch = selectedTest === 'all' || row.testName === selectedTest;

      return studentMatch && testIdMatch && testParamMatch && textMatch && classMatch && testMatch;
    });
  }, [pendingRows, filterStudent, filterTestId, filterTest, searchText, selectedClass, selectedTest]);

  const userInitials = useMemo(() => {
    if (!user) return 'T';
    if (user.displayName) {
      return user.displayName
        .split(' ')
        .filter(Boolean)
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
    }
    return (user.email || 'teacher').slice(0, 2).toUpperCase();
  }, [user]);

  const overallScore = useMemo(
    () => toSafeBand(task1Score * 0.33 + task2Score * 0.67),
    [task1Score, task2Score],
  );

  // Drag-drop handler for feedback file
  const feedbackDragDrop = useFileInputWithDragDrop({
    onFileSelect: (file) => setFeedbackFile(file),
    acceptedTypes: ['.doc', '.docx', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  });

  const openModal = (submission: ManualGradingSubmission) => {
    setSelected(submission);
    setTask1Score(submission.task1Score ?? 0);
    setTask2Score(submission.task2Score ?? 0);
    setComments('');
    setFeedbackFile(null);
  };

  const closeModal = () => {
    if (isSubmitting) return;
    setSelected(null);
  };

  useEffect(() => {
    autoOpenFromQueryRef.current = false;
  }, [openMode, filterStudent, filterTestId, filterTest]);

  useEffect(() => {
    if (autoOpenFromQueryRef.current) return;
    if (openMode !== 'grade') return;
    if (isLoading || isRefreshing) return;
    if (!filterStudent && !filterTestId && !filterTest) return;
    if (visibleRows.length === 0) return;

    const exactTarget = visibleRows.find((row) => {
      const studentMatched = !filterStudent
        || row.studentEmail.toLowerCase() === filterStudent
        || row.studentName.toLowerCase() === filterStudent;
      const testIdMatched = !filterTestId || row.testId === filterTestId;
      const testMatched = !filterTest || row.testName.toLowerCase() === filterTest;
      return studentMatched && testIdMatched && testMatched;
    });

    openModal(exactTarget || visibleRows[0]);
    autoOpenFromQueryRef.current = true;
  }, [openMode, isLoading, isRefreshing, filterStudent, filterTestId, filterTest, visibleRows]);

  const handleExport = () => {
    if (!selected) return;
    const content = buildWordCompatibleDocument(selected);
    const blob = new Blob([content], { type: 'application/msword;charset=utf-8' });
    const href = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `${selected.studentName || 'student'}_${selected.testName || 'writing_test'}.doc`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(href);
  };

  const handleSelectFeedbackFile = (event: ChangeEvent<HTMLInputElement>) => {
    setFeedbackFile(event.target.files?.[0] || null);
  };

  const uploadFeedback = async (file: File, submission: ManualGradingSubmission) => {
    const storage = getStorage(firebaseApp);
    const safeEmail = submission.studentEmail.replace(/[^a-zA-Z0-9]/g, '_');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileRef = ref(storage, `manual-grading-feedback/${submission.testId}/${safeEmail}/${Date.now()}_${safeName}`);

    await uploadBytes(fileRef, file);
    const url = await getDownloadURL(fileRef);
    return { url, fileName: file.name };
  };

  const handleSubmitGrade = async () => {
    if (!selected || !user?.email) return;

    if (task1Score < 0 || task1Score > 9 || task2Score < 0 || task2Score > 9) {
      alert('Task scores must be between 0 and 9.');
      return;
    }

    try {
      setIsSubmitting(true);

      let feedbackFileName: string | null = null;
      let feedbackFileUrl: string | null = null;

      if (feedbackFile) {
        const uploaded = await uploadFeedback(feedbackFile, selected);
        feedbackFileName = uploaded.fileName;
        feedbackFileUrl = uploaded.url;
      }

      await submitManualGrade({
        submissionId: selected.id,
        attemptId: selected.attemptId,
        teacherEmail: user.email,
        task1Score: toSafeBand(task1Score),
        task2Score: toSafeBand(task2Score),
        writingScore: overallScore,
        comments,
        feedbackFileName,
        feedbackFileUrl,
      });

      closeModal();
      await loadSubmissions(true);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Failed to submit grade.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    if (!auth) return;
    if (!confirm('Are you sure you want to logout?')) return;

    try {
      await signOut(auth);
      localStorage.clear();
      router.push('/login');
    } catch {
      router.push('/login');
    }
  };

  return (
    <div className="dashboard-container manual-grading-page">
      <div className="left-edge-zone" onMouseEnter={() => setSidebarOpen(true)} />

      <aside ref={sidebarRef} className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="logo">hanh94esl</div>
          <div className="user-role">Smart Teacher Dashboard</div>
        </div>

        <nav className="sidebar-nav">
          <a href="/teacher" className="nav-item">
            <i className="fas fa-tachometer-alt" />
            <span>Dashboard</span>
          </a>
          <a href="/teacher/tests" className="nav-item">
            <i className="fas fa-database" />
            <span>Test Hub</span>
          </a>
          <a href="/teacher/upload" className="nav-item">
            <i className="fas fa-upload" />
            <span>Upload Test</span>
          </a>
          <a href="/teacher/grading" className="nav-item active">
            <i className="fas fa-pen-fancy" />
            <span>Manual Grading</span>
          </a>
          <a href="/teacher/users" className="nav-item">
            <i className="fas fa-users-cog" />
            <span>Manage Users</span>
          </a>
          <button type="button" className="nav-item" onClick={handleLogout}>
            <i className="fas fa-sign-out-alt" />
            <span>Logout</span>
          </button>
        </nav>
      </aside>

      <main className="main-content">
        <header className="top-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarOpen((value) => !value)}
              title="Toggle Sidebar"
              aria-label="Toggle Sidebar"
            >
              <i className="fas fa-bars" />
            </button>
            <h1 className="page-title">Manual Grading</h1>
          </div>

          <div className="user-info">
            <div className="user-avatar">
              {user?.photoURL ? <img src={user.photoURL} alt={user.displayName || 'Teacher'} /> : <span>{userInitials}</span>}
            </div>
            <div className="user-details">
              <h4>{user?.displayName || user?.email?.split('@')[0] || 'Teacher'}</h4>
              <p>IELTS Teacher</p>
            </div>
            <button type="button" className="logout-btn" onClick={handleLogout}>
              <i className="fas fa-sign-out-alt" /> Logout
            </button>
          </div>
        </header>

        <div className="content-area">
          <section className="card grading-card">
            <div className="card-header grading-header">
              <div>
                <h2 className="card-title">Writing Submissions</h2>
                <p className="card-subtitle">Grade writing submissions that require human evaluation</p>
                <p className="pending-counter">Pending now: <strong>{pendingRows.length}</strong></p>
              </div>
              <button type="button" className="refresh-btn" onClick={() => loadSubmissions(true)} disabled={isRefreshing || isLoading}>
                <i className="fas fa-sync-alt" /> {isRefreshing ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>

            <div className="grading-filters">
              <div className="grading-search-wrap">
                <i className="fas fa-search" aria-hidden="true" />
                <input
                  type="text"
                  className="grading-search-input"
                  placeholder="Search by student, email, class, or test..."
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                />
              </div>

              <select
                className="grading-filter-select"
                value={selectedClass}
                onChange={(event) => setSelectedClass(event.target.value)}
              >
                <option value="all">All classes</option>
                {classOptions.map((className) => (
                  <option key={className} value={className}>{className}</option>
                ))}
              </select>

              <select
                className="grading-filter-select"
                value={selectedTest}
                onChange={(event) => setSelectedTest(event.target.value)}
              >
                <option value="all">All tests</option>
                {testOptions.map((testName) => (
                  <option key={testName} value={testName}>{testName}</option>
                ))}
              </select>

              <button
                type="button"
                className="clear-filter-btn"
                onClick={() => {
                  setSearchText('');
                  setSelectedClass('all');
                  setSelectedTest('all');
                }}
                disabled={searchText.length === 0 && selectedClass === 'all' && selectedTest === 'all'}
              >
                Clear
              </button>
            </div>

            <p className="filter-result-text">Showing <strong>{visibleRows.length}</strong> of <strong>{pendingRows.length}</strong> pending submissions</p>

            {error ? (
              <div className="manual-error">{error}</div>
            ) : isLoading ? (
              <div className="manual-loading">
                <i className="fas fa-spinner" /> Loading submissions...
              </div>
            ) : (
              <div className="table-container">
                <table className="table grading-table">
                  <thead>
                    <tr>
                      <th>Student Name</th>
                      <th>Test Title</th>
                      <th>Submitted Time</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="no-data">No pending submissions found.</td>
                      </tr>
                    ) : (
                      visibleRows.map((submission) => (
                        <tr key={submission.id}>
                          <td>
                            <div className="student-cell">
                              <div className="student-avatar">{getStudentInitials(submission)}</div>
                              <div>
                                <div className="student-name">{submission.studentName}</div>
                                <div className="student-meta">{submission.classCode} ({submission.studentEmail})</div>
                              </div>
                            </div>
                          </td>
                          <td>{submission.testName}</td>
                          <td>{formatDateTime(submission.submittedAt)}</td>
                          <td>
                            <span className="status-pill pending">Pending</span>
                          </td>
                          <td>
                            <button type="button" className="grade-btn" onClick={() => openModal(submission)}>
                              <i className="fas fa-eye" /> Grade
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </main>

      {selected ? (
        <div className="grading-modal-overlay" onClick={closeModal}>
          <div className="grading-modal" onClick={(event) => event.stopPropagation()}>
            <div className="grading-modal-header">
              <div>
                <h3>Grade Writing Submission</h3>
                <p>Student: {selected.studentName}</p>
              </div>
              <button type="button" className="close-modal-btn" onClick={closeModal}>
                <i className="fas fa-times" />
              </button>
            </div>

            <div className="grading-modal-actions">
              <button type="button" className="export-btn" onClick={handleExport}>
                <i className="fas fa-file-export" /> Export to DOCX
              </button>
              <div
                ref={feedbackDragDrop.zoneRef}
                className={`upload-btn ${feedbackDragDrop.isDragging ? 'is-dragging' : ''}`}
                onDragEnter={feedbackDragDrop.handleDragEnter}
                onDragLeave={feedbackDragDrop.handleDragLeave}
                onDragOver={feedbackDragDrop.handleDragOver}
                onDrop={feedbackDragDrop.handleDrop}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    feedbackDragDrop.trigger();
                  }
                }}
              >
                <i className="fas fa-upload" /> Upload Feedback
                <input
                  ref={feedbackDragDrop.inputRef}
                  type="file"
                  accept=".doc,.docx"
                  onChange={(event) => { const file = event.target.files?.[0] || null; setFeedbackFile(file); event.target.value = ''; }}
                  aria-label="Upload feedback file"
                />
              </div>
            </div>

            <div className="grading-modal-body">
              <div className="submission-panel">
                <article className="task-box">
                  <h4><i className="fas fa-list" /> Task 1: Academic Writing</h4>
                  <div className="task-content">{selected.task1Content || 'No content available.'}</div>
                </article>

                <article className="task-box">
                  <h4><i className="fas fa-pen" /> Task 2: Essay Writing</h4>
                  <div className="task-content">{selected.task2Content || 'No content available.'}</div>
                </article>
              </div>

              <aside className="grading-panel">
                <h4><i className="fas fa-clipboard-check" /> Grading Panel</h4>

                <label className="score-label" htmlFor="task1-score">Task 1 Score (0.0 - 9.0)</label>
                <input
                  id="task1-score"
                  type="number"
                  min={0}
                  max={9}
                  step={0.5}
                  value={task1Score}
                  onChange={(event) => setTask1Score(toSafeBand(Number(event.target.value)))}
                  className="score-input"
                />

                <label className="score-label" htmlFor="task2-score">Task 2 Score (0.0 - 9.0)</label>
                <input
                  id="task2-score"
                  type="number"
                  min={0}
                  max={9}
                  step={0.5}
                  value={task2Score}
                  onChange={(event) => setTask2Score(toSafeBand(Number(event.target.value)))}
                  className="score-input"
                />

                <div className="overall-score-box">
                  <div>Overall Writing Score</div>
                  <strong>{overallScore.toFixed(1)}</strong>
                  <small>Task 1: 33% | Task 2: 67%</small>
                </div>

                <label className="score-label" htmlFor="grading-comments">Comments</label>
                <textarea
                  id="grading-comments"
                  className="comments-input"
                  rows={5}
                  placeholder="Add grading comments..."
                  value={comments}
                  onChange={(event) => setComments(event.target.value)}
                />

                <div className="feedback-file-box">
                  {feedbackFile ? (
                    <span><i className="fas fa-file" /> {feedbackFile.name}</span>
                  ) : selected.feedbackFileName ? (
                    <a href={selected.feedbackFileUrl || '#'} target="_blank" rel="noreferrer">
                      <i className="fas fa-paperclip" /> {selected.feedbackFileName}
                    </a>
                  ) : (
                    <span>No feedback file uploaded</span>
                  )}
                </div>

                <div className="grading-panel-actions">
                  <button type="button" className="cancel-btn" onClick={closeModal} disabled={isSubmitting}>Cancel</button>
                  <button type="button" className="submit-btn" onClick={handleSubmitGrade} disabled={isSubmitting}>
                    {isSubmitting ? 'Submitting...' : 'Submit Grade'}
                  </button>
                </div>
              </aside>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
