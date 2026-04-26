'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import { collection, getFirestore, onSnapshot } from 'firebase/firestore';
import { firebaseApp } from '@/services/firebase';
import { clearAuthState } from '@/services/auth';
import { calculateDashboardStats, getRecentActivity, invalidateDashboardDataCache, type ActivityRecord, type DashboardStats } from '@/services/dashboard';
import './teacher-dashboard.css';

export function TeacherDashboardContent() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [auth, setAuth] = useState<any>(null);
  const [loadingProgress, setLoadingProgress] = useState('Initializing...');
  const sidebarRef = useRef<HTMLElement | null>(null);
  const loadSequenceRef = useRef(0);

  // Initialize auth on client
  useEffect(() => {
    if (typeof window === 'undefined') return; // Only on client
    try {
      const authInstance = getAuth(firebaseApp);
      setAuth(authInstance);
    } catch (err) {
      console.error('Auth initialization error:', err);
      setError('Failed to initialize authentication');
    }
  }, []);

  // Auth check
  useEffect(() => {
    if (!auth) return; // Wait for auth to be initialized
    
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) {
        setUser(null);
        return;
      }
      setUser(currentUser);
    });

    return () => unsubscribe();
  }, [auth, router]);

  const loadDashboardData = async ({
    showLoading = true,
    clearCache = false,
    progressMessage = 'Loading dashboard metrics...',
  }: {
    showLoading?: boolean;
    clearCache?: boolean;
    progressMessage?: string;
  } = {}) => {
    if (!user?.email) return;

    const requestSequence = ++loadSequenceRef.current;

    try {
      if (showLoading) {
        setIsLoading(true);
      }
      setError(null);
      setLoadingProgress(progressMessage);

      if (clearCache) {
        invalidateDashboardDataCache(user.email);
      }

      const [dashboardStats, recentActivities] = await Promise.all([
        calculateDashboardStats(user.email),
        getRecentActivity(user.email),
      ]);

      if (requestSequence !== loadSequenceRef.current) return;

      setStats(dashboardStats);
      setActivities(recentActivities);
    } catch (err) {
      if (requestSequence !== loadSequenceRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      if (requestSequence === loadSequenceRef.current && showLoading) {
        setIsLoading(false);
      }
    }
  };

  // Load dashboard data and keep it synced with Firestore changes
  useEffect(() => {
    if (!user?.email) return;

    const db = getFirestore(firebaseApp);
    const unsubscribeFunctions: Array<() => void> = [];
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let active = true;

    const scheduleRefresh = () => {
      if (!active) return;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }

      refreshTimer = setTimeout(() => {
        if (!active) return;
        loadDashboardData({
          showLoading: false,
          clearCache: true,
          progressMessage: 'Syncing latest changes...',
        });
      }, 200);
    };

    const watchQuery = (source: Parameters<typeof onSnapshot>[0]) => {
      let isInitialSnapshot = true;
      const unsubscribe = onSnapshot(source, () => {
        if (isInitialSnapshot) {
          isInitialSnapshot = false;
          return;
        }
        scheduleRefresh();
      });
      unsubscribeFunctions.push(unsubscribe);
    };

    loadDashboardData({ showLoading: true, progressMessage: 'Loading dashboard metrics...' });

    watchQuery(collection(db, 'tests'));
    watchQuery(collection(db, 'attempts'));
    watchQuery(collection(db, 'writing'));
    watchQuery(collection(db, 'users'));
    watchQuery(collection(db, 'classes'));

    const interval = setInterval(() => {
      if (!active) return;
      loadDashboardData({
        showLoading: false,
        clearCache: true,
        progressMessage: 'Refreshing dashboard data...',
      });
    }, 5 * 60 * 1000);

    return () => {
      active = false;
      clearInterval(interval);
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      unsubscribeFunctions.forEach((unsubscribe) => unsubscribe());
    };
  }, [user?.email]);

  const handleLogout = async () => {
    if (!confirm('Are you sure you want to logout?')) return;
    try {
      await signOut(auth);
      clearAuthState();
      router.push('/login');
    } catch (err) {
      console.error('Logout error:', err);
      clearAuthState();
      router.push('/login');
    }
  };

  const handleRefresh = async () => {
    if (!user?.email) return;
    try {
      await loadDashboardData({
        showLoading: true,
        clearCache: true,
        progressMessage: 'Refreshing dashboard data...',
      });
    } catch (err) {
      setError('Failed to refresh dashboard');
    }
  };

  const userInitials = useMemo(() => {
    if (!user) return 'T';
    if (user.displayName) {
      return user.displayName.split(' ').map((n: string) => n[0]).join('').toUpperCase();
    }
    return user.email?.split('@')[0].substring(0, 2).toUpperCase() || 'T';
  }, [user]);

  const getStatusBadgeClass = (status: string) => {
    const key = (status || '').toLowerCase();
    if (key === 'completed') return 'badge badge-success';
    if (key === 'pending') return 'badge badge-warning';
    if (key === 'graded') return 'badge badge-success';
    return 'badge badge-info';
  };

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

  const formatActivityDate = (value: string | Date) => {
    const date = new Date(value);
    const dayPart = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const timePart = date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    return `${dayPart}, ${timePart}`;
  };

  const buildManualGradingTarget = (activity: ActivityRecord) => {
    const params = new URLSearchParams();

    if (activity.studentEmail) params.set('student', activity.studentEmail);
    if (activity.testId) params.set('testId', activity.testId);
    if (activity.testName) params.set('test', activity.testName);
    params.set('open', 'grade');

    return `/teacher/grading?${params.toString()}`;
  };

  const buildTestHubTarget = (activity: ActivityRecord) => {
    const params = new URLSearchParams();

    if (activity.studentEmail) params.set('student', activity.studentEmail);
    if (activity.testId) params.set('testId', activity.testId);
    if (activity.testName) params.set('test', activity.testName);
    if (activity.testSkill) params.set('skill', activity.testSkill);
    params.set('open', 'students');

    return `/teacher/tests?${params.toString()}`;
  };

  const handleActivityAction = (activity: ActivityRecord, isPending: boolean) => {
    if (isPending) {
      router.push(buildManualGradingTarget(activity));
      return;
    }

    const skill = String(activity.testSkill || '').trim().toLowerCase();
    if (skill === 'listening' || skill === 'reading') {
      router.push(buildTestHubTarget(activity));
      return;
    }

    router.push(buildManualGradingTarget(activity));
  };

  return (
    <div className="dashboard-container">
      <div
        className="left-edge-zone"
        onMouseEnter={() => setSidebarOpen(true)}
      />

      <aside
        ref={sidebarRef}
        className={`sidebar ${sidebarOpen ? 'open' : ''}`}
      >
        <div className="sidebar-header">
          <div className="logo">hanh94esl</div>
          <div className="user-role">Smart Teacher Dashboard</div>
        </div>

        <nav className="sidebar-nav">
          <a href="/teacher" className="nav-item active">
            <i className="fas fa-tachometer-alt"></i>
            <span>Dashboard</span>
          </a>
          <a href="/teacher/tests" className="nav-item">
            <i className="fas fa-database"></i>
            <span>Test Hub</span>
          </a>
          <a href="/teacher/upload" className="nav-item">
            <i className="fas fa-upload"></i>
            <span>Upload Test</span>
          </a>
          <a href="/teacher/grading" className="nav-item">
            <i className="fas fa-pen-fancy"></i>
            <span>Manual Grading</span>
          </a>
          <a href="/teacher/users" className="nav-item">
            <i className="fas fa-users-cog"></i>
            <span>Manage Users</span>
          </a>
          <button type="button" onClick={handleLogout} className="nav-item">
            <i className="fas fa-sign-out-alt"></i>
            <span>Logout</span>
          </button>
        </nav>
      </aside>

      <main className="main-content">
        <header className="top-bar">
          <div className="top-bar-left" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              title="Toggle Sidebar"
              aria-label="Toggle sidebar"
            >
              <i className="fas fa-bars"></i>
            </button>
            <h1 className="page-title">Smart Dashboard</h1>
          </div>

          <div className="user-info">
              <div className="user-avatar">
                {user?.photoURL ? (
                  <img src={user.photoURL} alt={user?.displayName || 'Teacher'} />
                ) : (
                  <span>{userInitials}</span>
                )}
              </div>
              <div className="user-details">
                <h4>{user?.displayName || user?.email?.split('@')[0] || 'Teacher'}</h4>
                <p>IELTS Teacher</p>
              </div>
              <button type="button" className="logout-btn" onClick={handleLogout}>
                <i className="fas fa-sign-out-alt"></i> Logout
              </button>
            </div>
        </header>

        <div className="content-area">
          {error ? (
            <div className="error-state" style={{ textAlign: 'center', padding: '3rem' }}>
              <div style={{ color: '#e53e3e', fontSize: '3rem', marginBottom: '1rem' }}>
                <i className="fas fa-exclamation-triangle" />
              </div>
              <h3>Error Loading Dashboard</h3>
              <p>{error}</p>
              <button type="button" onClick={handleRefresh} className="btn-retry">
                <i className="fas fa-redo"></i> Retry
              </button>
            </div>
          ) : isLoading ? (
            <div className="loading-state" style={{ padding: '2rem' }}>
              <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
                  <div className="dashboard-loading-spinner" aria-hidden="true" />
                <p style={{ color: 'var(--text-medium)', fontWeight: 500 }}>Loading dashboard...</p>
                <p style={{ color: 'var(--text-light)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{loadingProgress}</p>
              </div>
              <div className="grid grid-4">
                {[0, 1, 2, 3].map((idx) => (
                  <div key={idx} className="skeleton-card" style={{ animationDelay: `${idx * 0.1}s` }} />
                ))}
              </div>
            </div>
          ) : stats ? (
            <>
              <div className="grid grid-4">
                <div className="stat-card">
                  <div className="stat-icon">
                    <i className="fas fa-file-alt"></i>
                  </div>
                  <div className="stat-number">{stats.totalTests}</div>
                  <div className="stat-label">Total Tests</div>
                  <div className="stat-change positive">{stats.totalTests} total</div>
                </div>

                <div className="stat-card">
                  <div className="stat-icon">
                    <i className="fas fa-users"></i>
                  </div>
                  <div className="stat-number">{stats.activeStudents}</div>
                  <div className="stat-label">Active Students</div>
                  <div className="stat-change positive">{stats.activeStudents} active</div>
                </div>

                <div className="stat-card">
                  <div className="stat-icon">
                    <i className="fas fa-chart-line"></i>
                  </div>
                  <div className="stat-number">{stats.averageScore.toFixed(1)}</div>
                  <div className="stat-label">Average Score</div>
                  <div className="stat-change positive">{stats.averageScore.toFixed(1)} average</div>
                </div>

                <div className="stat-card">
                  <div className="stat-icon">
                    <i className="fas fa-clock"></i>
                  </div>
                  <div className="stat-number">{stats.pendingGrading}</div>
                  <div className="stat-label">Pending Grading</div>
                  <div className="stat-change warning">Requires attention</div>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Quick Actions</h2>
                    <p className="card-subtitle">Common tasks and shortcuts</p>
                  </div>
                </div>
                <div className="grid grid-4">
                  <a href="/teacher/tests" className="quick-action">
                    <div className="quick-action-icon"><i className="fas fa-database" /></div>
                    <div className="quick-action-title">Test Hub</div>
                    <div className="quick-action-desc">Manage all tests</div>
                  </a>
                  <a href="/teacher/upload" className="quick-action">
                    <div className="quick-action-icon"><i className="fas fa-upload" /></div>
                    <div className="quick-action-title">Upload Test</div>
                    <div className="quick-action-desc">Create new test</div>
                  </a>
                  <a href="/teacher/grading" className="quick-action">
                    <div className="quick-action-icon"><i className="fas fa-pen-fancy" /></div>
                    <div className="quick-action-title">Grade Papers</div>
                    <div className="quick-action-desc">Review submissions</div>
                  </a>
                  <a href="/teacher/users" className="quick-action">
                    <div className="quick-action-icon"><i className="fas fa-users-cog" /></div>
                    <div className="quick-action-title">Manage Users</div>
                    <div className="quick-action-desc">Manage all user roles</div>
                  </a>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Skill Performance Overview</h2>
                    <p className="card-subtitle">Comprehensive analysis of student performance across all IELTS skills</p>
                  </div>
                  <button type="button" onClick={handleRefresh} className="btn-refresh" disabled={isLoading}>
                    <i className={`fas fa-sync-alt ${isLoading ? 'fa-spin' : ''}`}></i>
                    Refresh Data
                  </button>
                </div>
                {stats?.skillStats && (
                  <>
                    <div className="skill-grid">
                      <div className="skill-item skill-listening">
                        <div className="skill-header">
                          <div className="skill-title-row">
                            <div className="skill-icon-box"><i className="fas fa-headphones" /></div>
                            <div>
                              <h3>Listening</h3>
                              <p className="skill-subtitle">Audio comprehension skills</p>
                            </div>
                          </div>
                        </div>
                        <div className="skill-score skill-score-listening">{stats.skillStats.listening.average.toFixed(1)}</div>
                        <p className="skill-meta">{stats.skillStats.listening.count} attempts</p>
                        <div className="progress-bar">
                          <div className="progress-fill progress-fill-listening" style={{ width: `${Math.min((stats.skillStats.listening.average / 9) * 100, 100)}%` }} />
                        </div>
                        <div className="progress-scale"><span>0.0</span><span>9.0</span></div>
                      </div>

                      <div className="skill-item skill-reading">
                        <div className="skill-header">
                          <div className="skill-title-row">
                            <div className="skill-icon-box"><i className="fas fa-book-open" /></div>
                            <div>
                              <h3>Reading</h3>
                              <p className="skill-subtitle">Text comprehension skills</p>
                            </div>
                          </div>
                        </div>
                        <div className="skill-score skill-score-reading">{stats.skillStats.reading.average.toFixed(1)}</div>
                        <p className="skill-meta">{stats.skillStats.reading.count} attempts</p>
                        <div className="progress-bar">
                          <div className="progress-fill progress-fill-reading" style={{ width: `${Math.min((stats.skillStats.reading.average / 9) * 100, 100)}%` }} />
                        </div>
                        <div className="progress-scale"><span>0.0</span><span>9.0</span></div>
                      </div>

                      <div className="skill-item skill-writing">
                        <div className="skill-header">
                          <div className="skill-title-row">
                            <div className="skill-icon-box"><i className="fas fa-pen-fancy" /></div>
                            <div>
                              <h3>Writing</h3>
                              <p className="skill-subtitle">Essay writing skills</p>
                            </div>
                          </div>
                        </div>
                        <div className="skill-score skill-score-writing">{stats.skillStats.writing.average.toFixed(1)}</div>
                        <p className="skill-meta">{stats.skillStats.writing.count} attempts</p>
                        <div className="progress-bar">
                          <div className="progress-fill progress-fill-writing" style={{ width: `${Math.min((stats.skillStats.writing.average / 9) * 100, 100)}%` }} />
                        </div>
                        <div className="progress-scale"><span>0.0</span><span>9.0</span></div>
                      </div>

                    </div>

                    <div className="overall-performance-card">
                      <div className="overall-center-flex">
                        <div className="overall-left">
                          <div className="overall-left-header">
                            <i className="fas fa-trophy" />
                            <h3>Overall Performance</h3>
                          </div>
                          <p>Combined average across all skills</p>
                        </div>
                        <div className="overall-right">
                          <div className="overall-number-wrap">
                            <span className="score-badge-large">{stats.averageScore.toFixed(1)}</span>
                            <span className="overall-denominator">/ 9.0</span>
                          </div>
                          <div className="overall-attempts">
                            {stats.skillStats.listening.count + stats.skillStats.reading.count + stats.skillStats.writing.count} total attempts
                          </div>
                        </div>
                      </div>
                      <div className="overall-footer-note">Based on completed assessments</div>
                    </div>
                  </>
                )}
              </div>

              <div className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Recent Activity</h2>
                    <p className="card-subtitle">Latest student submissions and activities</p>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={handleRefresh}
                      disabled={isLoading}
                      style={{
                        background: 'var(--primary-dark)',
                        color: 'white',
                        border: 'none',
                        padding: '0.5rem 1rem',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontSize: '0.9rem',
                      }}
                    >
                      <i className={`fas fa-sync-alt ${isLoading ? 'fa-spin' : ''}`}></i> Refresh
                    </button>
                  </div>
                </div>

                <div className="table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Student</th>
                        <th>Test</th>
                        <th>Score</th>
                        <th>Date</th>
                        <th style={{ textAlign: 'center' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody style={{ verticalAlign: 'middle' }}>
                      {activities.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-medium)', padding: '2rem' }}>
                            No recent activity found. Students will appear here when they complete tests.
                          </td>
                        </tr>
                      ) : (
                        activities.map((activity) => {
                          const isWriting = activity.testSkill?.toLowerCase() === 'writing';
                          const isPending = isWriting && !activity.score;
                          
                          return (
                            <tr key={activity.id} style={{ height: '90px', verticalAlign: 'middle' }}>
                              <td style={{ padding: '1rem 0.5rem 1rem 0', verticalAlign: 'middle' }}>
                                <strong>
                                  {activity.studentName}
                                  {activity.className ? ` - ${activity.className}` : ''}
                                </strong>
                                {activity.studentEmail ? (
                                  <div style={{ color: 'var(--text-medium)', fontSize: '0.8rem', marginTop: '0.2rem' }}>{activity.studentEmail}</div>
                                ) : null}
                              </td>
                              <td style={{ padding: '1rem 0.5rem', verticalAlign: 'middle' }}>
                                <div>{activity.testName}</div>
                                {activity.testSkill ? (
                                  <div style={{ color: 'var(--text-medium)', fontSize: '0.85rem', marginTop: '0.2rem' }}>{activity.testSkill.toUpperCase()}</div>
                                ) : null}
                              </td>
                              <td style={{ padding: '1rem 0.5rem', verticalAlign: 'middle' }}>
                                {isPending ? (
                                  <span style={{
                                    background: '#fed7aa',
                                    color: '#b45309',
                                    padding: '0.3rem 0.75rem',
                                    borderRadius: '0.375rem',
                                    fontSize: '0.85rem',
                                    fontWeight: 'bold',
                                    display: 'inline-block',
                                  }}>
                                    Pending
                                  </span>
                                ) : (
                                  <strong style={{ color: '#047857', fontSize: '0.95rem' }}>
                                    {typeof activity.score === 'number' ? activity.score.toFixed(1) : 'N/A'}
                                  </strong>
                                )}
                              </td>
                              <td style={{ padding: '1rem 0.5rem', verticalAlign: 'middle' }}>
                                <div style={{ lineHeight: '1.4' }}>{formatActivityDate(activity.date)}</div>
                                {activity.timeSpentMinutes !== null && (
                                  <div style={{ color: '#9ca3af', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                                    Time: {activity.timeSpentMinutes} mins
                                  </div>
                                )}
                              </td>
                              <td style={{ padding: '1rem 0.5rem', verticalAlign: 'middle', textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                                {isPending ? (
                                  <button 
                                    type="button"
                                    style={{
                                      background: '#f59e0b',
                                      color: 'white',
                                      border: 'none',
                                      padding: '0.4rem 0.9rem',
                                      borderRadius: '0.5rem',
                                      fontSize: '0.8rem',
                                      fontWeight: '500',
                                      cursor: 'pointer',
                                      transition: 'background-color 0.2s',
                                      whiteSpace: 'nowrap',
                                    }}
                                    onClick={() => handleActivityAction(activity, isPending)}
                                    onMouseEnter={(e) => (e.currentTarget.style.background = '#d97706')}
                                    onMouseLeave={(e) => (e.currentTarget.style.background = '#f59e0b')}
                                  >
                                    <i className="fas fa-pen-fancy"></i> Grade Now
                                  </button>
                                ) : (
                                  <button 
                                    type="button"
                                    style={{
                                      background: 'transparent',
                                      color: '#6b7280',
                                      border: '1px solid #d1d5db',
                                      padding: '0.4rem 0.9rem',
                                      borderRadius: '0.5rem',
                                      fontSize: '0.8rem',
                                      fontWeight: '500',
                                      cursor: 'pointer',
                                      transition: 'all 0.2s',
                                      whiteSpace: 'nowrap',
                                    }}
                                    onClick={() => handleActivityAction(activity, isPending)}
                                    onMouseEnter={(e) => {
                                      e.currentTarget.style.background = '#f3f4f6';
                                      e.currentTarget.style.borderColor = '#9ca3af';
                                    }}
                                    onMouseLeave={(e) => {
                                      e.currentTarget.style.background = 'transparent';
                                      e.currentTarget.style.borderColor = '#d1d5db';
                                    }}
                                  >
                                    <i className="fas fa-eye"></i> View Details
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <p>Loading dashboard data...</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
