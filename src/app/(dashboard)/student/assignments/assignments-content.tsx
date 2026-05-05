'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import { clearAuthState } from '@/services/auth';
import { firebaseApp } from '@/services/firebase';
import { fetchStudentAssignments, type Assignment, type AssignmentStatus } from '@/services/student-assignments';
import { fetchStudentClassName } from '@/services/student-profile';
import '../student-dashboard.css';
import './assignments.css';

type StatusFilter = 'all' | AssignmentStatus;
type SkillFilter = 'all' | 'listening' | 'reading' | 'writing';

function statusLabel(status: AssignmentStatus): string {
  if (status === 'NOT_DONE') return 'Not done';
  return 'Completed';
}

function statusIcon(status: AssignmentStatus): string {
  if (status === 'NOT_DONE') return 'fas fa-circle';
  return 'fas fa-check-circle';
}

function statusClass(status: AssignmentStatus): string {
  if (status === 'NOT_DONE') return 'sa-badge not-done';
  return 'sa-badge completed';
}

function skillLabel(skill: Assignment['skill']): string {
  if (skill === 'listening') return 'Listening';
  if (skill === 'reading') return 'Reading';
  if (skill === 'writing') return 'Writing';
  return 'General';
}

function skillIcon(skill: Assignment['skill']): string {
  if (skill === 'listening') return 'fas fa-headphones';
  if (skill === 'reading') return 'fas fa-book-open';
  if (skill === 'writing') return 'fas fa-pen-fancy';
  return 'fas fa-layer-group';
}

function skillClass(skill: Assignment['skill']): string {
  if (skill === 'listening') return 'listening';
  if (skill === 'reading') return 'reading';
  if (skill === 'writing') return 'writing';
  return 'general';
}

function formatDate(value: Date | null | undefined): string {
  if (!value) return '—';
  return value.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(value: Date | null | undefined): string {
  if (!value) return '—';
  const diff = Date.now() - value.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours} hr ago`;
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(value);
}

function assignmentStartHref(testId: string): string {
  return `/student/take-test?testId=${encodeURIComponent(testId)}`;
}

function assignmentReviewHref(testId: string): string {
  return `/student/performance?reviewTestId=${encodeURIComponent(testId)}`;
}

export function AssignmentsContent() {
  const router = useRouter();
  const auth = useMemo(() => {
    try {
      return getAuth(firebaseApp);
    } catch {
      return null;
    }
  }, []);
  const [user, setUser] = useState<any>(null);
  const [className, setClassName] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);

  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [skillFilter, setSkillFilter] = useState<SkillFilter>('all');

  const loadSeq = useRef(0);

  async function loadAssignments(email: string, uid: string) {
    const seq = ++loadSeq.current;
    setIsLoading(true);
    setError(null);

    const data = await fetchStudentAssignments(email, uid);
    if (seq !== loadSeq.current) return;

    setAssignments(data);
    setIsLoading(false);
  }

  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser ?? null);
      setClassName(null);
      if (!currentUser) {
        router.replace('/login');
        return;
      }

      void fetchStudentClassName(currentUser.email ?? '').then(setClassName);
      void loadAssignments(currentUser.email ?? '', currentUser.uid);
    });
    return () => unsubscribe();
  }, [auth, router]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const handler = (event: MouseEvent) => {
      if (sidebarRef.current && !sidebarRef.current.contains(event.target as Node)) {
        setSidebarOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [sidebarOpen]);

  const handleLogout = async () => {
    if (!confirm('Are you sure you want to logout?')) return;
    try {
      if (auth) {
        await signOut(auth);
      }
    } catch {
      /* continue */
    }
    clearAuthState();
    router.push('/login');
  };

  const userInitials = useMemo(() => {
    if (!user) return 'S';
    if (user.displayName) {
      return user.displayName
        .split(' ')
        .map((part: string) => part[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
    }
    return user.email?.split('@')[0].slice(0, 2).toUpperCase() ?? 'S';
  }, [user]);

  const filteredAssignments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return assignments.filter((assignment) => {
      if (statusFilter !== 'all' && assignment.status !== statusFilter) return false;
      if (skillFilter !== 'all' && assignment.skill !== skillFilter) return false;
      if (!query) return true;

      const haystack = [assignment.name, assignment.skill, assignment.status, statusLabel(assignment.status), assignment.id]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [assignments, searchQuery, skillFilter, statusFilter]);

  const initError = auth ? null : 'Failed to initialize authentication.';
  const displayError = error ?? initError;
  const showEmpty = !isLoading && filteredAssignments.length === 0;

  return (
    <div className="sd-container sa-page">
      <div className="sd-edge-zone" onMouseEnter={() => setSidebarOpen(true)} />

      <aside ref={sidebarRef} className={`sd-sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sd-sidebar-header">
          <div className="sd-logo">hanh94esl</div>
          <div className="sd-user-role">Student Portal</div>
        </div>
        <nav className="sd-nav">
          <a href="/student" className="sd-nav-item">
            <i className="fas fa-tachometer-alt" /><span>My Dashboard</span>
          </a>
          <a href="/student/assignments" className="sd-nav-item active">
            <i className="fas fa-tasks" /><span>Assignments</span>
          </a>
          <a href="/student/performance" className="sd-nav-item">
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

      <main className="sd-main sa-main">
        <header className="sd-topbar">
          <div className="sd-topbar-left">
            <button
              type="button"
              className="sd-menu-btn"
              onClick={() => setSidebarOpen((value) => !value)}
              aria-label="Toggle sidebar"
            >
              <i className="fas fa-bars" />
            </button>
            <h1 className="sd-page-title">Assignments</h1>
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

        <div className="sd-content sa-content">
          {displayError && (
            <div className="sa-state sa-state-error">
              <div className="sa-state-icon"><i className="fas fa-triangle-exclamation" /></div>
              <h2>{displayError}</h2>
              <p>Reload the page or sign in again to restore the assignment feed.</p>
              <button type="button" className="sa-primary-btn" onClick={() => { setIsLoading(true); void loadAssignments(user?.email ?? '', user?.uid ?? ''); }}>
                Retry
              </button>
            </div>
          )}

          {isLoading && !displayError && (
            <div className="sa-loading-grid">
              <div className="sa-skeleton-panel skeleton" />
              <div className="sa-skeleton-panel skeleton" />
            </div>
          )}

          {!isLoading && !displayError && (
            <>
              <section className="sa-toolbar">
                <label className="sa-search">
                  <i className="fas fa-search" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search assignment name or status"
                  />
                </label>

                <div className="sa-filter-row">
                  <div className="sa-chip-group">
                    {(['all', 'NOT_DONE', 'COMPLETED'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`sa-chip ${statusFilter === value ? 'active' : ''}`}
                        onClick={() => setStatusFilter(value)}
                      >
                        {value === 'all' ? 'All statuses' : statusLabel(value)}
                      </button>
                    ))}
                  </div>

                  <div className="sa-chip-group">
                    {(['all', 'listening', 'reading', 'writing'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`sa-chip ${skillFilter === value ? 'active' : ''}`}
                        onClick={() => setSkillFilter(value)}
                      >
                        {value === 'all' ? 'All skills' : skillLabel(value)}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="sa-list-panel sa-basic-panel">
                <div className="sa-panel-header">
                  <div>
                    <h3>Class assignments</h3>
                    <p>{filteredAssignments.length} assignment{filteredAssignments.length === 1 ? '' : 's'} match your filters.</p>
                  </div>
                </div>

                {showEmpty ? (
                  <div className="sa-empty-state">
                    <div className="sa-empty-icon"><i className="fas fa-inbox" /></div>
                    <h4>No assignments match this view.</h4>
                    <p>Clear the search or switch to another status to see more cards.</p>
                    <button type="button" className="sa-secondary-btn" onClick={() => { setSearchQuery(''); setStatusFilter('all'); setSkillFilter('all'); }}>
                      Reset filters
                    </button>
                  </div>
                ) : (
                  <div className="sa-card-grid">
                    {filteredAssignments.map((assignment) => {
                      const isCompleted = assignment.status === 'COMPLETED';
                      return (
                        <article key={assignment.id} className="sa-card">
                          <div className="sa-card-top">
                            <div className={`sa-skill-badge ${skillClass(assignment.skill)}`}>
                              <i className={skillIcon(assignment.skill)} />
                              <span>{skillLabel(assignment.skill)}</span>
                            </div>
                            <span className={statusClass(assignment.status)}>
                              <i className={statusIcon(assignment.status)} />
                              {statusLabel(assignment.status)}
                            </span>
                          </div>

                          <h4>{assignment.name}</h4>

                          <div className="sa-card-meta basic">
                            <div>
                              <span>Created</span>
                              <strong>{formatDate(assignment.createdAt)}</strong>
                            </div>
                            <div>
                              <span>Last activity</span>
                              <strong>{timeAgo(assignment.lastActivityAt ?? assignment.createdAt)}</strong>
                            </div>
                            {isCompleted ? (
                              <div>
                                <span>Band</span>
                                <strong>{assignment.band !== undefined ? assignment.band.toFixed(1) : '—'}</strong>
                              </div>
                            ) : (
                              <div>
                                <span>Type</span>
                                <strong>{skillLabel(assignment.skill)}</strong>
                              </div>
                            )}
                          </div>

                          <div className="sa-card-footer basic">
                            {isCompleted ? (
                              <>
                                <a href={assignmentReviewHref(assignment.id)} className="sa-card-action">
                                  Review result
                                </a>
                                <a href={assignmentStartHref(assignment.id)} className="sa-card-action muted">
                                  Retake
                                </a>
                              </>
                            ) : (
                              <a href={assignmentStartHref(assignment.id)} className="sa-card-action">
                                Start test
                              </a>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
