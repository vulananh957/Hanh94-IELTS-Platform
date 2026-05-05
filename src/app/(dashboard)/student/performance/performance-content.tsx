'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import { firebaseApp } from '@/services/firebase';
import { clearAuthState } from '@/services/auth';
import { fetchStudentWritingResults, type WritingResult } from '@/services/student-writing-results';
import { fetchStudentObjectiveTests, type ObjectiveTestResult } from '@/services/student-objective-tests';
import { fetchStudentClassName } from '@/services/student-profile';
import { WritingResultCard } from './WritingResultCard';
import { WritingResultDrawer } from './WritingResultDrawer';
import { ObjectiveTestDrawer } from './ObjectiveTestDrawer';
import '../student-dashboard.css';
import './performance.css';

const ITEMS_PER_PAGE = 10;

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function skillLabel(skill: 'listening' | 'reading') {
  return skill === 'listening' ? 'Listening' : 'Reading';
}

function skillIconClass(skill: 'listening' | 'reading') {
  return skill === 'listening' ? 'fas fa-headphones' : 'fas fa-book-open';
}

// ── Component ──────────────────────────────────────────────────────────────────

type Tab = 'objective' | 'feedback';

export function PerformanceContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [auth, setAuth] = useState<any>(null);
  const [user, setUser] = useState<any>(null);
  const [className, setClassName] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);

  const [activeTab, setActiveTab] = useState<Tab>('objective');

  // Objective Tests state
  const [objTests, setObjTests] = useState<ObjectiveTestResult[]>([]);
  const [objPage, setObjPage] = useState(0);
  const [objLoading, setObjLoading] = useState(true);
  const [objError, setObjError] = useState<string | null>(null);
  const [selectedObjTest, setSelectedObjTest] = useState<ObjectiveTestResult | null>(null);
  const [objDrawerIdx, setObjDrawerIdx] = useState(0);

  // Writing Feedback state
  const [writingResults, setWritingResults] = useState<WritingResult[]>([]);
  const [writingPage, setWritingPage] = useState(0);
  const [writingLoading, setWritingLoading] = useState(true);
  const [writingError, setWritingError] = useState<string | null>(null);

  // Filter state for writing
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'graded' | 'pending'>('all');
  const [timeFilter, setTimeFilter] = useState<'all' | '7' | '30' | '90'>('all');

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedResult, setSelectedResult] = useState<WritingResult | null>(null);

  const loadSeq = useRef(0);
  const deepLinkHandled = useRef(false);

  // Auth init
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { setAuth(getAuth(firebaseApp)); } catch { setObjError('Auth init failed'); }
  }, []);

  // Watch auth state
  useEffect(() => {
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u ?? null);
      setClassName(null);
      if (!u) router.replace('/login');
      if (u?.email) void fetchStudentClassName(u.email).then(setClassName);
    });
    return () => unsub();
  }, [auth, router]);

  // Load data
  const loadData = useCallback(async (email: string) => {
    const seq = ++loadSeq.current;

    const [objData, writingData] = await Promise.allSettled([
      fetchStudentObjectiveTests(email),
      fetchStudentWritingResults(email),
    ]);

    if (seq !== loadSeq.current) return;

    if (objData.status === 'fulfilled') {
      setObjTests(objData.value);
    } else {
      setObjError('Failed to load objective test history.');
    }
    setObjLoading(false);

    if (writingData.status === 'fulfilled') {
      setWritingResults(writingData.value);
    } else {
      setWritingError('Failed to load writing feedback.');
    }
    setWritingLoading(false);
  }, []);

  useEffect(() => {
    if (!user?.email) return;
    setObjLoading(true);
    setWritingLoading(true);
    setObjError(null);
    setWritingError(null);
    loadData(user.email);
  }, [user?.email, loadData]);

  // Sidebar close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (sidebarOpen && sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
        const tgt = e.target as HTMLElement;
        if (!tgt.closest('.sd-sidebar-toggle') && !tgt.closest('.sd-sidebar-overlay')) {
          setSidebarOpen(false);
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [sidebarOpen]);

  const handleLogout = async () => {
    if (!auth) return;
    if (confirm('Are you sure you want to log out?')) {
      try {
        clearAuthState();
        await signOut(auth);
        router.replace('/login');
      } catch (err) {
        console.error('Logout error:', err);
      }
    }
  };

  const userInitials = user?.displayName
    ? user.displayName.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
    : user?.email?.split('@')[0].slice(0, 2).toUpperCase() ?? 'S';

  // ── Computed lists ─────────────────────────────────────────────────────────

  const objTotalPages = Math.ceil(objTests.length / ITEMS_PER_PAGE);
  const objPaginated = objTests.slice(objPage * ITEMS_PER_PAGE, (objPage + 1) * ITEMS_PER_PAGE);

  const filteredWritingResults = useMemo(() => {
    return writingResults.filter(r => {
      // search
      if (searchQuery && !r.testName.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      
      // status
      if (statusFilter === 'graded' && r.writingScore === 'Pending') return false;
      if (statusFilter === 'pending' && r.writingScore !== 'Pending') return false;
      
      // time
      if (timeFilter !== 'all') {
        const days = parseInt(timeFilter, 10);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        if (r.submittedAt < cutoff) return false;
      }
      
      return true;
    });
  }, [writingResults, searchQuery, statusFilter, timeFilter]);

  const writingTotalPages = Math.ceil(filteredWritingResults.length / ITEMS_PER_PAGE);
  // Reset writing page if out of bounds after filtering
  useEffect(() => {
    if (writingPage >= writingTotalPages && writingTotalPages > 0) {
      setWritingPage(writingTotalPages - 1);
    } else if (writingTotalPages === 0) {
      setWritingPage(0);
    }
  }, [writingTotalPages, writingPage]);

  const writingPaginated = filteredWritingResults.slice(writingPage * ITEMS_PER_PAGE, (writingPage + 1) * ITEMS_PER_PAGE);

  // ── Drawer Navigation ──────────────────────────────────────────────────────

  const selectedIndex = selectedResult ? filteredWritingResults.findIndex(r => r.id === selectedResult.id) : -1;
  const hasPrev = selectedIndex > 0;
  const hasNext = selectedIndex !== -1 && selectedIndex < filteredWritingResults.length - 1;

  const handlePrev = () => {
    if (hasPrev) setSelectedResult(filteredWritingResults[selectedIndex - 1]);
  };
  const handleNext = () => {
    if (hasNext) setSelectedResult(filteredWritingResults[selectedIndex + 1]);
  };

  const openDrawer = (result: WritingResult) => {
    setSelectedResult(result);
    setDrawerOpen(true);
  };

  useEffect(() => {
    const reviewTestId = searchParams.get('reviewTestId')?.trim();
    if (!reviewTestId || deepLinkHandled.current) return;
    if (objLoading || writingLoading) return;

    const objectiveMatchIdx = objTests.findIndex((test) => test.testId === reviewTestId);
    if (objectiveMatchIdx >= 0) {
      const objectiveMatch = objTests[objectiveMatchIdx];
      setActiveTab('objective');
      setObjPage(Math.floor(objectiveMatchIdx / ITEMS_PER_PAGE));
      setSelectedObjTest(objectiveMatch);
      setObjDrawerIdx(objectiveMatchIdx + 1);
      deepLinkHandled.current = true;
      return;
    }

    const writingMatch = writingResults.find((result) => result.testId === reviewTestId || result.id === reviewTestId);
    if (writingMatch) {
      setActiveTab('feedback');
      openDrawer(writingMatch);
      const writingMatchIdx = filteredWritingResults.findIndex((result) => result.id === writingMatch.id);
      if (writingMatchIdx >= 0) {
        setWritingPage(Math.floor(writingMatchIdx / ITEMS_PER_PAGE));
      }
      deepLinkHandled.current = true;
      return;
    }

    deepLinkHandled.current = true;
  }, [
    searchParams,
    objLoading,
    writingLoading,
    objTests,
    writingResults,
    filteredWritingResults,
  ]);

  return (
    <div className="sd-container">
      {/* Edge zone */}
      <div className="sd-edge-zone" onMouseEnter={() => setSidebarOpen(true)} />

      {/* Sidebar */}
      <aside ref={sidebarRef} className={`sd-sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sd-sidebar-header">
          <div className="sd-logo">hanh94esl</div>
          <div className="sd-user-role">Student Portal</div>
        </div>
        <nav className="sd-nav">
          <a href="/student" className="sd-nav-item">
            <i className="fas fa-tachometer-alt" /><span>My Dashboard</span>
          </a>
          <a href="/student/assignments" className="sd-nav-item">
            <i className="fas fa-tasks" /><span>Assignments</span>
          </a>
          <a href="/student/performance" className="sd-nav-item active">
            <i className="fas fa-chart-line" /><span>Performance</span>
          </a>
          <a href="/student/settings" className="sd-nav-item">
            <i className="fas fa-cog" /><span>Settings</span>
          </a>
          <button type="button" onClick={handleLogout} className="sd-nav-item" style={{ marginTop: 'auto' }}>
            <i className="fas fa-sign-out-alt" /><span>Logout</span>
          </button>
        </nav>
      </aside>

      {/* Main */}
      <main className="sd-main">
        {/* Top bar */}
        <header className="sd-topbar">
          <div className="sd-topbar-left">
            <button
              className="sd-menu-btn"
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label="Toggle sidebar"
            >
              <i className="fas fa-bars" />
            </button>
            <h1 className="sd-page-title">Performance</h1>
          </div>
          <div className="sd-topbar-right">
            <div className="sd-user-avatar">
              {user?.photoURL
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={user.photoURL} alt={user.displayName ?? 'Student'} />
                : <span>{userInitials}</span>
              }
            </div>
            <div>
              <div className="sd-user-name">{user?.displayName || user?.email?.split('@')[0] || 'Student'}</div>
              {className && <div className="sd-user-class">{className}</div>}
            </div>
            <button type="button" className="sd-logout-btn" onClick={handleLogout}>
              <i className="fas fa-sign-out-alt" /> Logout
            </button>
          </div>
        </header>

        {/* Content */}
        <div className="sd-content">
          <div className="perf-container">

            {/* Page header */}
            <div className="perf-header">
              <div>
                <h2>Performance Archive</h2>
                <p>Your complete record of tests, scores, and teacher feedback</p>
              </div>
            </div>

            {/* Tab Nav */}
            <div className="perf-tabs" role="tablist">
              <button
                role="tab"
                type="button"
                className={`perf-tab ${activeTab === 'objective' ? 'active' : ''}`}
                aria-selected={activeTab === 'objective'}
                onClick={() => setActiveTab('objective')}
              >
                <i className="fas fa-headphones-alt" />
                Objective Tests
                {objTests.length > 0 && (
                  <span className="perf-tab-count">{objTests.length}</span>
                )}
              </button>
              <button
                role="tab"
                type="button"
                className={`perf-tab ${activeTab === 'feedback' ? 'active' : ''}`}
                aria-selected={activeTab === 'feedback'}
                onClick={() => setActiveTab('feedback')}
              >
                <i className="fas fa-comment-dots" />
                Teacher Feedback
                {writingResults.length > 0 && (
                  <span className="perf-tab-count">{writingResults.length}</span>
                )}
              </button>
            </div>

            {/* ── TAB 1: Objective Tests ── */}
            {activeTab === 'objective' && (
              <div className="perf-tab-panel" role="tabpanel">
                {objError && (
                  <div className="perf-error">
                     <i className="fas fa-exclamation-triangle" />
                    <p>{objError}</p>
                    <button type="button" onClick={() => { setObjLoading(true); loadData(user?.email); }}>
                      <i className="fas fa-redo" /> Retry
                    </button>
                  </div>
                )}

                {objLoading && !objError && (
                  <div className="sd-loading" style={{ minHeight: '280px' }}>
                    <div className="sd-spinner" />
                    <span>Loading test history…</span>
                  </div>
                )}

                {!objLoading && !objError && objTests.length === 0 && (
                  <div className="wr-empty">
                    <i className="fas fa-headphones-alt" />
                    <h3>No Objective Tests Yet</h3>
                    <p>Complete a listening or reading test to see your results here.</p>
                    <a href="/student/assignments" className="wr-empty-btn">
                      <i className="fas fa-arrow-left" /> Browse Assignments
                    </a>
                  </div>
                )}

                {!objLoading && !objError && objTests.length > 0 && (
                  <>
                    <div className="obj-list">
                      {objPaginated.map((test, idx) => {
                        const globalIdx = objPage * ITEMS_PER_PAGE + idx + 1;
                        return (
                          <div key={test.id} className="obj-card" style={{ cursor: 'pointer' }} onClick={() => {
                            setSelectedObjTest(test);
                            setObjDrawerIdx(globalIdx);
                          }}>
                            <div className="obj-card-left">
                              <div className={`obj-skill-icon ${test.skill}`}>
                                <i className={skillIconClass(test.skill)} />
                              </div>
                              <div className="obj-card-info">
                                <div className="obj-card-title">
                                  <span className="obj-num">#{globalIdx}</span>
                                  {test.testName}
                                </div>
                                <div className="obj-card-meta">
                                  <span className="obj-skill-tag">{skillLabel(test.skill)}</span>
                                  <span className="obj-date">{timeAgo(test.completedAt)}</span>
                                  {test.correctAnswers != null && test.totalQuestions != null && (
                                    <span className="obj-answers">
                                      {test.correctAnswers}/{test.totalQuestions} correct
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="obj-card-right">
                              {test.band !== null ? (
                                <div className="obj-band">
                                  <div className="obj-band-value">{test.band.toFixed(1)}</div>
                                  <div className="obj-band-label">Band</div>
                                </div>
                              ) : (
                                <div className="obj-band-na">—</div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {objTotalPages > 1 && (
                      <div className="wr-pagination">
                        <button
                          className="wr-page-btn"
                          disabled={objPage === 0}
                          onClick={() => { setObjPage(p => p - 1); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                        >
                          <i className="fas fa-arrow-left" style={{ marginRight: '0.5rem' }} /> Previous
                        </button>
                        <span className="wr-page-info">Page {objPage + 1} of {objTotalPages}</span>
                        <button
                          className="wr-page-btn"
                          disabled={objPage === objTotalPages - 1}
                          onClick={() => { setObjPage(p => p + 1); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                        >
                          Next <i className="fas fa-arrow-right" style={{ marginLeft: '0.5rem' }} />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── TAB 2: Teacher Feedback ── */}
            {activeTab === 'feedback' && (
              <div className="perf-tab-panel" role="tabpanel">
                {writingError && (
                  <div className="perf-error">
                    <i className="fas fa-exclamation-triangle" />
                    <p>{writingError}</p>
                    <button type="button" onClick={() => { setWritingLoading(true); loadData(user?.email); }}>
                      <i className="fas fa-redo" /> Retry
                    </button>
                  </div>
                )}

                {writingLoading && !writingError && (
                  <div className="sd-loading" style={{ minHeight: '280px' }}>
                    <div className="sd-spinner" />
                    <span>Loading writing assessments…</span>
                  </div>
                )}

                {!writingLoading && !writingError && (
                  <>
                    <div className="perf-filters">
                      <input
                        id="wr-search"
                        type="text"
                        className="perf-filter-input"
                        placeholder="Search tests..."
                        aria-label="Search writing tests"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                      <select
                        id="wr-status-filter"
                        className="perf-filter-select"
                        aria-label="Filter by grading status"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as any)}
                      >
                        <option value="all">All Status</option>
                        <option value="graded">Graded</option>
                        <option value="pending">Pending</option>
                      </select>
                      <select
                        id="wr-time-filter"
                        className="perf-filter-select"
                        aria-label="Filter by time period"
                        value={timeFilter}
                        onChange={(e) => setTimeFilter(e.target.value as any)}
                      >
                        <option value="all">All Time</option>
                        <option value="7">Last 7 days</option>
                        <option value="30">Last 30 days</option>
                        <option value="90">Last 90 days</option>
                      </select>
                    </div>

                    {filteredWritingResults.length === 0 ? (
                      <div className="wr-empty" style={{ minHeight: '200px' }}>
                        <i className="fas fa-search" />
                        <h3>No results found</h3>
                        <p>No feedback matches your current filters.</p>
                      </div>
                    ) : (
                      <>
                        <div className="wrc-list">
                          {writingPaginated.map((result, idx) => {
                            const globalIndex = writingPage * ITEMS_PER_PAGE + idx + 1;
                            return (
                              <WritingResultCard
                                key={result.id}
                                result={result}
                                index={globalIndex}
                                onSelect={openDrawer}
                              />
                            );
                          })}
                        </div>

                        {writingTotalPages > 1 && (
                          <div className="wr-pagination">
                            <button
                              className="wr-page-btn"
                              disabled={writingPage === 0}
                              onClick={() => { setWritingPage(p => p - 1); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                            >
                              <i className="fas fa-arrow-left" style={{ marginRight: '0.5rem' }} /> Previous
                            </button>
                            <span className="wr-page-info">Page {writingPage + 1} of {writingTotalPages}</span>
                            <button
                              className="wr-page-btn"
                              disabled={writingPage === writingTotalPages - 1}
                              onClick={() => { setWritingPage(p => p + 1); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                            >
                              Next <i className="fas fa-arrow-right" style={{ marginLeft: '0.5rem' }} />
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}

          </div>
        </div>
      </main>
      
      {/* Writing Drawer */}
      <WritingResultDrawer 
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        result={selectedResult}
        onPrev={handlePrev}
        onNext={handleNext}
        hasPrev={hasPrev}
        hasNext={hasNext}
      />

      {/* Objective Test Drawer */}
      {selectedObjTest && (
        <ObjectiveTestDrawer
          test={selectedObjTest}
          index={objDrawerIdx}
          onClose={() => setSelectedObjTest(null)}
          onPrev={() => {
            const currentIdx = objTests.findIndex((t) => t.id === selectedObjTest.id);
            if (currentIdx > 0) {
              setSelectedObjTest(objTests[currentIdx - 1]);
              setObjDrawerIdx(objDrawerIdx - 1);
            }
          }}
          onNext={() => {
            const currentIdx = objTests.findIndex((t) => t.id === selectedObjTest.id);
            if (currentIdx < objTests.length - 1) {
              setSelectedObjTest(objTests[currentIdx + 1]);
              setObjDrawerIdx(objDrawerIdx + 1);
            }
          }}
          hasPrev={objTests.findIndex((t) => t.id === selectedObjTest.id) > 0}
          hasNext={objTests.findIndex((t) => t.id === selectedObjTest.id) < objTests.length - 1}
        />
      )}
    </div>
  );
}
