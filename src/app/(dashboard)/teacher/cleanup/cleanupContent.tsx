'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import {
  collection,
  getDocs,
  getFirestore,
  limit,
  query,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { firebaseApp } from '@/services/firebase';
import { clearAuthState } from '@/services/auth';
import '../teacher-dashboard.css';
import './cleanup.css';

type TeacherRole = 'teacher' | 'testCreator' | 'student' | 'admin' | string;

type OrphanPreviewRow = {
  id: string;
  testId: string;
  studentEmail: string;
  status: string;
  eventTimeMs: number | null;
  eventTimeLabel: string;
  path: string;
};

type CleanupSummary = {
  existingTests: number;
  attemptsTotal: number;
  testResultsTotal: number;
  writingTotal: number;
  orphanAttempts: number;
  orphanTestResults: number;
  orphanWriting: number;
  scannedAt: Date | null;
};

const PREVIEW_LIMIT = 120;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown, fallback = '-'): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function toMillis(value: unknown): number | null {
  if (!value) return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  const record = asRecord(value);
  if (typeof record.toDate === 'function') {
    const converted = (record.toDate as () => Date)();
    const ms = converted.getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  if (typeof record.seconds === 'number') {
    return Math.round(Number(record.seconds) * 1000);
  }

  const parsed = new Date(String(value));
  const ms = parsed.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function formatEventTime(ms: number | null): string {
  if (!ms || !Number.isFinite(ms)) return '-';

  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '-';

  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function sortPreviewRows(rows: OrphanPreviewRow[]): OrphanPreviewRow[] {
  return [...rows].sort((a, b) => {
    const aTime = a.eventTimeMs ?? -1;
    const bTime = b.eventTimeMs ?? -1;
    if (aTime !== bTime) return bTime - aTime;

    const emailCompare = a.studentEmail.localeCompare(b.studentEmail, 'en', { sensitivity: 'base' });
    if (emailCompare !== 0) return emailCompare;

    return a.id.localeCompare(b.id, 'en', { sensitivity: 'base' });
  });
}

export function CleanupContent() {
  const router = useRouter();
  const sidebarRef = useRef<HTMLElement | null>(null);
  const orphanDocsRef = useRef<{
    attempts: Array<QueryDocumentSnapshot<DocumentData>>;
    testResults: Array<QueryDocumentSnapshot<DocumentData>>;
    writing: Array<QueryDocumentSnapshot<DocumentData>>;
  }>({ attempts: [], testResults: [], writing: [] });
  const autoScanDoneRef = useRef(false);

  const [auth, setAuth] = useState<ReturnType<typeof getAuth> | null>(null);
  const [user, setUser] = useState<any>(null);
  const [userRole, setUserRole] = useState<TeacherRole | null>(null);
  const [isRoleLoading, setIsRoleLoading] = useState(true);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);

  const [scanError, setScanError] = useState<string | null>(null);
  const [cleanError, setCleanError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string>('Scan orphan data before deletion.');

  const [summary, setSummary] = useState<CleanupSummary>({
    existingTests: 0,
    attemptsTotal: 0,
    testResultsTotal: 0,
    writingTotal: 0,
    orphanAttempts: 0,
    orphanTestResults: 0,
    orphanWriting: 0,
    scannedAt: null,
  });

  const [orphanAttemptRows, setOrphanAttemptRows] = useState<OrphanPreviewRow[]>([]);
  const [orphanTestResultRows, setOrphanTestResultRows] = useState<OrphanPreviewRow[]>([]);
  const [orphanWritingRows, setOrphanWritingRows] = useState<OrphanPreviewRow[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setAuth(getAuth(firebaseApp));
  }, []);

  useEffect(() => {
    if (!auth) return;

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) {
        setUser(null);
        return;
      }
      setUser(currentUser);
    });

    return () => unsubscribe();
  }, [auth, router]);

  const loadUserRole = useCallback(async (email: string) => {
    setIsRoleLoading(true);

    try {
      const db = getFirestore(firebaseApp);
      const userQuery = query(collection(db, 'users'), where('email', '==', email), limit(1));
      const snapshot = await getDocs(userQuery);

      if (snapshot.empty) {
        setUserRole(null);
        return;
      }

      const data = snapshot.docs[0].data() as Record<string, unknown>;
      setUserRole(asText(data.role, '').toLowerCase());
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Failed to verify role.');
      setUserRole(null);
    } finally {
      setIsRoleLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user?.email) return;
    void loadUserRole(user.email);
  }, [user?.email, loadUserRole]);

  const canRunCleanup = userRole === 'teacher' || userRole === 'testcreator' || userRole === 'admin';

  const scanOrphanData = useCallback(async () => {
    if (!canRunCleanup) return;

    setIsScanning(true);
    setScanError(null);
    setCleanError(null);
    setActionMessage('Scanning attempts/testResults against existing tests...');

    try {
      const db = getFirestore(firebaseApp);

      const [testsSnapshot, attemptsSnapshot, testResultsSnapshot, writingSnapshot] = await Promise.all([
        getDocs(collection(db, 'tests')),
        getDocs(collection(db, 'attempts')),
        getDocs(collection(db, 'testResults')),
        getDocs(collection(db, 'writing')),
      ]);

      const testIds = new Set<string>(testsSnapshot.docs.map((item) => item.id));

      const orphanAttemptsDocs: Array<QueryDocumentSnapshot<DocumentData>> = [];
      const orphanTestResultsDocs: Array<QueryDocumentSnapshot<DocumentData>> = [];
      const orphanWritingDocs: Array<QueryDocumentSnapshot<DocumentData>> = [];
      const orphanAttemptsPreview: OrphanPreviewRow[] = [];
      const orphanTestResultsPreview: OrphanPreviewRow[] = [];
      const orphanWritingPreview: OrphanPreviewRow[] = [];

      attemptsSnapshot.forEach((item) => {
        const data = item.data() as Record<string, unknown>;
        const testId = asText(data.testId, '').trim();

        if (testId && testIds.has(testId)) return;

        orphanAttemptsDocs.push(item);

        const eventTimeMs =
          toMillis(data.completedAt)
          ?? toMillis(data.submittedAt)
          ?? toMillis(data.updatedAt)
          ?? toMillis(data.createdAt);

        orphanAttemptsPreview.push({
          id: item.id,
          testId: testId || '(missing testId)',
          studentEmail: asText(data.studentEmail, '-'),
          status: asText(data.status, '-'),
          eventTimeMs,
          eventTimeLabel: formatEventTime(eventTimeMs),
          path: `attempts/${item.id}`,
        });
      });

      testResultsSnapshot.forEach((item) => {
        const data = item.data() as Record<string, unknown>;
        const testId = asText(data.testId, '').trim();

        if (testId && testIds.has(testId)) return;

        orphanTestResultsDocs.push(item);

        const eventTimeMs =
          toMillis(data.completedAt)
          ?? toMillis(data.updatedAt)
          ?? toMillis(data.createdAt);

        orphanTestResultsPreview.push({
          id: item.id,
          testId: testId || '(missing testId)',
          studentEmail: asText(data.studentEmail, '-'),
          status: asText(data.status, '-'),
          eventTimeMs,
          eventTimeLabel: formatEventTime(eventTimeMs),
          path: `testResults/${item.id}`,
        });
      });

      writingSnapshot.forEach((item) => {
        const data = item.data() as Record<string, unknown>;
        const testId = asText(data.testId, '').trim();

        if (testId && testIds.has(testId)) return;

        orphanWritingDocs.push(item);

        const eventTimeMs =
          toMillis(data.submittedAt)
          ?? toMillis(data.gradedAt)
          ?? toMillis(data.completedAt)
          ?? toMillis(data.createdAt);

        orphanWritingPreview.push({
          id: item.id,
          testId: testId || '(missing testId)',
          studentEmail: asText(data.studentEmail, '-'),
          status: asText(data.status, '-'),
          eventTimeMs,
          eventTimeLabel: formatEventTime(eventTimeMs),
          path: `writing/${item.id}`,
        });
      });

      orphanDocsRef.current = {
        attempts: orphanAttemptsDocs,
        testResults: orphanTestResultsDocs,
        writing: orphanWritingDocs,
      };

      setSummary({
        existingTests: testsSnapshot.size,
        attemptsTotal: attemptsSnapshot.size,
        testResultsTotal: testResultsSnapshot.size,
        writingTotal: writingSnapshot.size,
        orphanAttempts: orphanAttemptsDocs.length,
        orphanTestResults: orphanTestResultsDocs.length,
        orphanWriting: orphanWritingDocs.length,
        scannedAt: new Date(),
      });

      setOrphanAttemptRows(sortPreviewRows(orphanAttemptsPreview));
      setOrphanTestResultRows(sortPreviewRows(orphanTestResultsPreview));
      setOrphanWritingRows(sortPreviewRows(orphanWritingPreview));

      const orphanTotal = orphanAttemptsDocs.length + orphanTestResultsDocs.length + orphanWritingDocs.length;
      if (orphanTotal === 0) {
        setActionMessage('No orphan documents found. Dashboard data is already clean.');
      } else {
        setActionMessage(`Scan completed: ${orphanTotal} orphan documents found.`);
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Scan failed.');
      setActionMessage('Scan failed.');
    } finally {
      setIsScanning(false);
    }
  }, [canRunCleanup]);

  useEffect(() => {
    if (!canRunCleanup) return;
    if (autoScanDoneRef.current) return;

    autoScanDoneRef.current = true;
    void scanOrphanData();
  }, [canRunCleanup, scanOrphanData]);

  const handleCleanup = async () => {
    if (!canRunCleanup) return;

    const orphanAttemptDocs = orphanDocsRef.current.attempts;
    const orphanTestResultDocs = orphanDocsRef.current.testResults;
    const orphanWritingDocs = orphanDocsRef.current.writing;

    const totalOrphans = orphanAttemptDocs.length + orphanTestResultDocs.length + orphanWritingDocs.length;
    if (totalOrphans === 0) {
      setActionMessage('No orphan documents to delete.');
      return;
    }

    const confirmed = window.confirm(
      `Delete ${totalOrphans} orphan documents?\n\n` +
      `Attempts: ${orphanAttemptDocs.length}\n` +
      `Test Results: ${orphanTestResultDocs.length}\n` +
      `Writing: ${orphanWritingDocs.length}\n\n` +
      'This operation only removes results where testId does not exist in tests collection.',
    );

    if (!confirmed) return;

    setIsCleaning(true);
    setCleanError(null);
    setActionMessage(`Deleting 0/${totalOrphans} orphan documents...`);

    try {
      const db = getFirestore(firebaseApp);
      const chunkSize = 400;
      let deletedCount = 0;

      const commitInChunks = async (docs: Array<QueryDocumentSnapshot<DocumentData>>) => {
        for (let i = 0; i < docs.length; i += chunkSize) {
          const chunk = docs.slice(i, i + chunkSize);
          const batch = writeBatch(db);

          chunk.forEach((item) => batch.delete(item.ref));
          await batch.commit();

          deletedCount += chunk.length;
          setActionMessage(`Deleting ${deletedCount}/${totalOrphans} orphan documents...`);
        }
      };

      await commitInChunks(orphanAttemptDocs);
      await commitInChunks(orphanTestResultDocs);
      await commitInChunks(orphanWritingDocs);

      setActionMessage(`Cleanup done. Deleted ${deletedCount} orphan documents.`);
      await scanOrphanData();
    } catch (err) {
      setCleanError(err instanceof Error ? err.message : 'Cleanup failed.');
      setActionMessage('Cleanup failed.');
    } finally {
      setIsCleaning(false);
    }
  };

  const handleLogout = async () => {
    if (!auth) return;
    if (!confirm('Are you sure you want to logout?')) return;

    try {
      await signOut(auth);
      clearAuthState();
      router.push('/login');
    } catch {
      clearAuthState();
      router.push('/login');
    }
  };

  useEffect(() => {
    if (!sidebarOpen) return;

    const onDocClick = (event: MouseEvent) => {
      const node = sidebarRef.current;
      const target = event.target as Node | null;
      if (!node || !target) return;
      if (!node.contains(target)) setSidebarOpen(false);
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

  const userInitials = useMemo(() => {
    if (!user) return 'T';
    if (user.displayName) {
      return user.displayName
        .split(' ')
        .filter(Boolean)
        .map((part: string) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
    }

    return (user.email || 'teacher').slice(0, 2).toUpperCase();
  }, [user]);

  const attemptPreview = orphanAttemptRows.slice(0, PREVIEW_LIMIT);
  const testResultPreview = orphanTestResultRows.slice(0, PREVIEW_LIMIT);
  const writingPreview = orphanWritingRows.slice(0, PREVIEW_LIMIT);

  const totalOrphans = summary.orphanAttempts + summary.orphanTestResults + summary.orphanWriting;

  return (
    <div className="dashboard-container cleanup-page">
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
          <a href="/teacher/grading" className="nav-item">
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
            <h1 className="page-title">Data Cleanup</h1>
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

        <div className="content-area cleanup-content-area">
          <section className="card cleanup-card">
            <div className="cleanup-header-row">
              <div>
                <h2 className="card-title">Orphan Results Cleanup (Temporary Tool)</h2>
                <p className="card-subtitle">
                  Removes only attempts/testResults whose testId no longer exists in tests collection.
                </p>
              </div>

              <div className="cleanup-actions">
                <button
                  type="button"
                  className="cleanup-btn scan"
                  onClick={() => void scanOrphanData()}
                  disabled={isScanning || isCleaning || isRoleLoading || !canRunCleanup}
                >
                  <i className={`fas fa-search ${isScanning ? 'fa-spin' : ''}`} />
                  {isScanning ? 'Scanning...' : 'Scan Orphans'}
                </button>
                <button
                  type="button"
                  className="cleanup-btn danger"
                  onClick={() => void handleCleanup()}
                  disabled={isScanning || isCleaning || totalOrphans === 0 || !canRunCleanup}
                >
                  <i className={`fas fa-trash ${isCleaning ? 'fa-spin' : ''}`} />
                  {isCleaning ? 'Cleaning...' : 'Delete Orphans'}
                </button>
              </div>
            </div>

            {!isRoleLoading && !canRunCleanup ? (
              <div className="cleanup-alert error">Only teacher/test creator accounts can use this cleanup tool.</div>
            ) : null}

            {scanError ? <div className="cleanup-alert error">{scanError}</div> : null}
            {cleanError ? <div className="cleanup-alert error">{cleanError}</div> : null}
            {!scanError && !cleanError ? <div className="cleanup-alert info">{actionMessage}</div> : null}

            <div className="cleanup-summary-grid">
              <article className="cleanup-stat">
                <span>Existing Tests</span>
                <strong>{summary.existingTests}</strong>
              </article>
              <article className="cleanup-stat">
                <span>Total Attempts</span>
                <strong>{summary.attemptsTotal}</strong>
              </article>
              <article className="cleanup-stat">
                <span>Total Test Results</span>
                <strong>{summary.testResultsTotal}</strong>
              </article>
              <article className="cleanup-stat warn">
                <span>Orphan Attempts</span>
                <strong>{summary.orphanAttempts}</strong>
              </article>
              <article className="cleanup-stat">
                <span>Total Writing</span>
                <strong>{summary.writingTotal}</strong>
              </article>
              <article className="cleanup-stat warn">
                <span>Orphan Test Results</span>
                <strong>{summary.orphanTestResults}</strong>
              </article>
              <article className="cleanup-stat warn">
                <span>Orphan Writing</span>
                <strong>{summary.orphanWriting}</strong>
              </article>
            </div>

            <p className="cleanup-footnote">
              Last scan: {summary.scannedAt ? summary.scannedAt.toLocaleString('en-US') : 'Not scanned yet'}
            </p>
          </section>

          <section className="card cleanup-card">
            <div className="cleanup-table-header">
              <h3>Orphan Attempts Preview</h3>
              <span>
                Showing {Math.min(attemptPreview.length, PREVIEW_LIMIT)} / {summary.orphanAttempts}
              </span>
            </div>

            {attemptPreview.length === 0 ? (
              <p className="cleanup-empty">No orphan attempts found.</p>
            ) : (
              <div className="table-container">
                <table className="table cleanup-table">
                  <thead>
                    <tr>
                      <th>Path</th>
                      <th>Test ID</th>
                      <th>Student</th>
                      <th>Status</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attemptPreview.map((row) => (
                      <tr key={`attempt-${row.id}`}>
                        <td>{row.path}</td>
                        <td>{row.testId}</td>
                        <td>{row.studentEmail}</td>
                        <td>{row.status}</td>
                        <td>{row.eventTimeLabel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card cleanup-card">
            <div className="cleanup-table-header">
              <h3>Orphan Test Results Preview</h3>
              <span>
                Showing {Math.min(testResultPreview.length, PREVIEW_LIMIT)} / {summary.orphanTestResults}
              </span>
            </div>

            {testResultPreview.length === 0 ? (
              <p className="cleanup-empty">No orphan testResults found.</p>
            ) : (
              <div className="table-container">
                <table className="table cleanup-table">
                  <thead>
                    <tr>
                      <th>Path</th>
                      <th>Test ID</th>
                      <th>Student</th>
                      <th>Status</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testResultPreview.map((row) => (
                      <tr key={`result-${row.id}`}>
                        <td>{row.path}</td>
                        <td>{row.testId}</td>
                        <td>{row.studentEmail}</td>
                        <td>{row.status}</td>
                        <td>{row.eventTimeLabel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card cleanup-card">
            <div className="cleanup-table-header">
              <h3>Orphan Writing Preview</h3>
              <span>
                Showing {Math.min(writingPreview.length, PREVIEW_LIMIT)} / {summary.orphanWriting}
              </span>
            </div>

            {writingPreview.length === 0 ? (
              <p className="cleanup-empty">No orphan writing submissions found.</p>
            ) : (
              <div className="table-container">
                <table className="table cleanup-table">
                  <thead>
                    <tr>
                      <th>Path</th>
                      <th>Test ID</th>
                      <th>Student</th>
                      <th>Status</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {writingPreview.map((row) => (
                      <tr key={`writing-${row.id}`}>
                        <td>{row.path}</td>
                        <td>{row.testId}</td>
                        <td>{row.studentEmail}</td>
                        <td>{row.status}</td>
                        <td>{row.eventTimeLabel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
