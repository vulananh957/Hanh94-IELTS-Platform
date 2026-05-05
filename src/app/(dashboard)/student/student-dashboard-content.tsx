'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import { firebaseApp } from '@/services/firebase';
import { clearAuthState } from '@/services/auth';
import {
  fetchStudentDashboard,
  fetchStudentRecentActivity,
  invalidateStudentCache,
  type StudentDashboardStats,
  type StudentActivity,
} from '@/services/student-dashboard';
import './student-dashboard.css';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function normalizeSkill(skill: string): 'listening' | 'reading' | 'writing' | 'default' {
  const value = skill.trim().toLowerCase();
  if (value.includes('listening') || value.startsWith('listen') || value === 'l') return 'listening';
  if (value.includes('reading') || value.startsWith('read') || value === 'r') return 'reading';
  if (value.includes('writing') || value.startsWith('write') || value === 'w') return 'writing';
  return 'default';
}

function skillIcon(skill: string): string {
  const normalized = normalizeSkill(skill);
  if (normalized === 'listening') return 'fas fa-headphones';
  if (normalized === 'reading') return 'fas fa-book-open';
  if (normalized === 'writing') return 'fas fa-pen-fancy';
  return 'fas fa-clipboard-check';
}

function skillClass(skill: string): string {
  const normalized = normalizeSkill(skill);
  if (normalized === 'listening') return 'listening';
  if (normalized === 'reading') return 'reading';
  if (normalized === 'writing') return 'writing';
  return 'default';
}

// ─── Mini Calendar ─────────────────────────────────────────────────────────────

function MiniCalendar({ activityDates }: { activityDates: Set<string> }) {
  const [viewDate, setViewDate] = useState(() => new Date());

  const today = new Date();
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: Array<{ day: number | null; dateStr: string }> = [];
  for (let i = 0; i < firstDay; i++) cells.push({ day: null, dateStr: '' });
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month, d);
    cells.push({ day: d, dateStr: dt.toDateString() });
  }

  const monthLabel = viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div className="sd-card sd-calendar">
      <div className="sd-cal-header">
        <span className="sd-cal-month">{monthLabel}</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            className="sd-cal-nav"
            onClick={() => setViewDate(new Date(year, month - 1, 1))}
            aria-label="Previous month"
          >
            <i className="fas fa-chevron-left" />
          </button>
          <button
            className="sd-cal-nav"
            onClick={() => setViewDate(new Date(year, month + 1, 1))}
            aria-label="Next month"
          >
            <i className="fas fa-chevron-right" />
          </button>
        </div>
      </div>

      <div className="sd-cal-grid">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((n) => (
          <div key={n} className="sd-cal-dayname">{n}</div>
        ))}
        {cells.map((cell, idx) => {
          if (!cell.day) return <div key={`blank-${idx}`} />;
          const isToday = cell.dateStr === today.toDateString();
          const hasActivity = activityDates.has(cell.dateStr);
          return (
            <div
              key={cell.dateStr}
              className={`sd-cal-day${isToday ? ' today' : hasActivity ? ' has-activity' : ''}`}
              title={hasActivity ? 'Test completed' : undefined}
            >
              {cell.day}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Activity Chart ────────────────────────────────────────────────────────────

function ActivityChart({ points }: { points: StudentDashboardStats['weeklyActivity'] }) {
  const maxScore = 9;
  const hasAnyData = points.some((p) => p.score !== null);

  return (
    <div>
      <div className="sd-chart-wrap">
        {!hasAnyData && (
          <div className="sd-chart-empty">
            <i className="fas fa-chart-area" style={{ fontSize: '2rem', color: '#c6e3d4' }} />
            <span>No activity in the last 7 days</span>
          </div>
        )}
        {points.map((pt, i) => {
          const pct = pt.score !== null ? (pt.score / maxScore) * 100 : 0;
          const label = pt.score !== null ? `Band ${pt.score}` : 'No data';
          return (
            <div key={i} className="sd-chart-bar-col">
              <div
                className={`sd-chart-bar ${pt.score !== null ? 'has-data' : 'no-data'}`}
                style={{ height: `${Math.max(pct, pt.score !== null ? 6 : 2)}%` }}
                title={`${pt.day}: ${label}`}
              >
                <div className="sd-chart-tooltip">{label}</div>
              </div>
              <span className="sd-chart-day">{pt.day}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Skill progress bars ───────────────────────────────────────────────────────

function SkillProgress({ stats }: { stats: StudentDashboardStats['skillStats'] }) {
  const skills: Array<{
    key: keyof typeof stats;
    label: string;
    icon: string;
    cls: string;
  }> = [
    { key: 'listening', label: 'Listening', icon: 'fas fa-headphones', cls: 'listening' },
    { key: 'reading',   label: 'Reading',   icon: 'fas fa-book-open',  cls: 'reading'   },
    { key: 'writing',   label: 'Writing',   icon: 'fas fa-pen-fancy',  cls: 'writing'   },
  ];

  return (
    <div className="sd-skill-list">
      {skills.map(({ key, label, icon, cls }) => {
        const stat = stats[key];
        const hasData = stat.count > 0;
        const pct = hasData ? Math.min((stat.average / 9) * 100, 100) : 0;
        return (
          <div key={key} className="sd-skill-row">
            <div className="sd-skill-meta">
              <span className="sd-skill-name">
                <i className={icon} /> {label}
                {hasData && (
                  <span style={{ fontSize: '0.72rem', color: '#a0aec0', fontWeight: 400 }}>
                    &nbsp;({stat.count} test{stat.count !== 1 ? 's' : ''})
                  </span>
                )}
              </span>
              <span className="sd-skill-score">
                {hasData ? `Band ${stat.average.toFixed(1)}` : '—'}
              </span>
            </div>
            <div className="sd-skill-bar-bg">
              <div
                className={`sd-skill-bar-fill ${cls}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function StudentDashboardContent() {
  const router = useRouter();
  const [auth, setAuth] = useState<any>(null);
  const [user, setUser] = useState<any>(null);
  const [stats, setStats] = useState<StudentDashboardStats | null>(null);
  const [activities, setActivities] = useState<StudentActivity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const loadSeq = useRef(0);

  // Init auth
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { setAuth(getAuth(firebaseApp)); } catch { setError('Auth init failed'); }
  }, []);

  // Watch auth state
  useEffect(() => {
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u ?? null);
      if (!u) router.replace('/login');
    });
    return () => unsub();
  }, [auth, router]);

  // Load data
  const loadData = useCallback(async (clearCache = false) => {
    if (!user?.email) return;
    const seq = ++loadSeq.current;
    try {
      setError(null);
      if (clearCache) invalidateStudentCache(user.email);
      const [s, a] = await Promise.all([
        fetchStudentDashboard(user.email),
        fetchStudentRecentActivity(user.email),
      ]);
      if (seq !== loadSeq.current) return;
      setStats(s);
      setActivities(a);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      if (seq === loadSeq.current) setIsLoading(false);
    }
  }, [user?.email]);

  useEffect(() => {
    if (!user?.email) return;
    setIsLoading(true);
    loadData();
  }, [user?.email, loadData]);

  // Sidebar close on outside click
  useEffect(() => {
    if (!sidebarOpen) return;
    const handler = (e: MouseEvent) => {
      if (sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
        setSidebarOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [sidebarOpen]);

  // Sidebar auto-close on mouse move away
  useEffect(() => {
    if (!sidebarOpen) return;
    let timer: ReturnType<typeof setTimeout>;
    const handler = (e: MouseEvent) => {
      if (!sidebarRef.current?.matches(':hover') && e.clientX > 310) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => setSidebarOpen(false), 120);
      } else if (timer) clearTimeout(timer);
    };
    document.addEventListener('mousemove', handler);
    return () => { clearTimeout(timer); document.removeEventListener('mousemove', handler); };
  }, [sidebarOpen]);

  const handleLogout = async () => {
    if (!confirm('Are you sure you want to logout?')) return;
    try { await signOut(auth); } catch { /* continue */ }
    clearAuthState();
    router.push('/login');
  };

  const userInitials = useMemo(() => {
    if (!user) return 'S';
    if (user.displayName) return user.displayName.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);
    return user.email?.split('@')[0].slice(0, 2).toUpperCase() ?? 'S';
  }, [user]);

  // Build activity date set for calendar
  const activityDates = useMemo(() => {
    const s = new Set<string>();
    activities.forEach((a) => s.add(a.date.toDateString()));
    return s;
  }, [activities]);

  // ── Render ──────────────────────────────────────────────────────────────────
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
          <a href="/student" className="sd-nav-item active">
            <i className="fas fa-tachometer-alt" /><span>My Dashboard</span>
          </a>
          <a href="/student/assignments" className="sd-nav-item">
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
            <h1 className="sd-page-title">My Dashboard</h1>
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
              {stats?.className && <div className="sd-user-class">{stats.className}</div>}
            </div>
            <button type="button" className="sd-logout-btn" onClick={handleLogout}>
              <i className="fas fa-sign-out-alt" /> Logout
            </button>
          </div>
        </header>

        {/* Content */}
        <div className="sd-content">

          {/* Error */}
          {error && (
            <div className="sd-card" style={{ textAlign: 'center', padding: '2rem', color: '#e53e3e' }}>
              <i className="fas fa-exclamation-triangle" style={{ fontSize: '2rem', marginBottom: '0.75rem' }} />
              <p style={{ marginBottom: '1rem' }}>{error}</p>
              <button
                type="button"
                onClick={() => { setIsLoading(true); loadData(true); }}
                style={{ background: '#006769', color: '#fff', border: 'none', padding: '0.6rem 1.4rem', borderRadius: '8px', cursor: 'pointer' }}
              >
                <i className="fas fa-redo" /> Retry
              </button>
            </div>
          )}

          {/* Loading skeleton */}
          {isLoading && !error && (
            <>
              <div className="sd-stats-row">
                {[0,1,2,3].map((i) => (
                  <div key={i} className="sd-skeleton" style={{ height: '90px', animationDelay: `${i * 0.1}s` }} />
                ))}
              </div>
              <div className="sd-loading">
                <div className="sd-spinner" />
                <span>Loading your dashboard…</span>
              </div>
            </>
          )}

          {/* Main dashboard */}
          {!isLoading && !error && stats && (
            <>
              {/* Welcome */}
              <div className="sd-welcome">
                <div className="sd-welcome-text">
                  <h2>Welcome back, {user?.displayName?.split(' ')[0] || 'Student'} 👋</h2>
                  <p>Here&apos;s your IELTS progress at a glance{stats.className ? ` · ${stats.className}` : ''}</p>
                </div>
                <button
                  type="button"
                  className="sd-refresh-btn"
                  onClick={() => { setIsLoading(true); loadData(true); }}
                >
                  <i className="fas fa-sync-alt" /> Refresh
                </button>
              </div>

              {/* Stat cards */}
              <div className="sd-stats-row">
                <div className="sd-stat-card">
                  <div className="sd-stat-icon green"><i className="fas fa-check-circle" /></div>
                  <div className="sd-stat-body">
                    <div className="sd-stat-number">{stats.testsCompleted}</div>
                    <div className="sd-stat-label">Tests Completed</div>
                  </div>
                </div>
                <div className="sd-stat-card">
                  <div className="sd-stat-icon teal"><i className="fas fa-trophy" /></div>
                  <div className="sd-stat-body">
                    <div className="sd-stat-number">
                      {stats.overallBand !== null ? `${stats.overallBand.toFixed(1)}` : '—'}
                    </div>
                    <div className="sd-stat-label">Overall Band</div>
                  </div>
                </div>
                <div className="sd-stat-card">
                  <div className="sd-stat-icon lime"><i className="fas fa-clipboard-list" /></div>
                  <div className="sd-stat-body">
                    <div className="sd-stat-number">{stats.availableTests}</div>
                    <div className="sd-stat-label">Pending Assignments</div>
                  </div>
                </div>
                <div className="sd-stat-card">
                  <div className="sd-stat-icon amber"><i className="fas fa-pen-fancy" /></div>
                  <div className="sd-stat-body">
                    <div className="sd-stat-number">{stats.skillStats.writing.count}</div>
                    <div className="sd-stat-label">Writing Graded</div>
                  </div>
                </div>
              </div>

              {/* Zone Row 1: Activity Chart (left) + Calendar (right) */}
              <div className="sd-zone-row">
                {/* Activity Chart */}
                <div className="sd-card">
                  <div className="sd-card-header">
                    <span className="sd-card-title">My Learning Activity</span>
                    <span style={{ fontSize: '0.76rem', color: 'var(--c-subtle)' }}>Last 7 days</span>
                  </div>
                  <ActivityChart points={stats.weeklyActivity} />
                </div>

                {/* Mini Calendar */}
                <MiniCalendar activityDates={activityDates} />
              </div>

              {/* Quick Actions — full-width horizontal strip */}
              <div className="sd-quick-actions-strip">
                <a href="/student/assignments" className="sd-quick-action">
                  <div className="sd-quick-action-icon"><i className="fas fa-play-circle" /></div>
                  <div className="sd-quick-action-text">
                    <div className="sd-quick-action-title">Pending Assignments</div>
                    <div className="sd-quick-action-desc">
                      {stats.availableTests} assignment{stats.availableTests !== 1 ? 's' : ''} available
                    </div>
                  </div>
                </a>
                <a href="/student/performance" className="sd-quick-action">
                  <div className="sd-quick-action-icon"><i className="fas fa-chart-line" /></div>
                  <div className="sd-quick-action-text">
                    <div className="sd-quick-action-title">Performance</div>
                    <div className="sd-quick-action-desc">Review attempts & feedback</div>
                  </div>
                </a>
                <a href="/student/settings" className="sd-quick-action">
                  <div className="sd-quick-action-icon"><i className="fas fa-cog" /></div>
                  <div className="sd-quick-action-text">
                    <div className="sd-quick-action-title">Settings</div>
                    <div className="sd-quick-action-desc">Manage your profile</div>
                  </div>
                </a>
              </div>

              {/* Zone Row 2: Progress Stats (left) + Recent Activity (right) */}
              <div className="sd-zone-row">
                {/* Progress Statistics */}
                <div className="sd-card sd-progress-card">
                  <div className="sd-card-header">
                    <span className="sd-card-title">Progress Statistics</span>
                    {stats.overallBand !== null && (
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '0.73rem', color: 'var(--c-subtle)' }}>Overall Band</div>
                        <div style={{ fontSize: '1.55rem', fontWeight: 700, color: 'var(--c-deep)', lineHeight: 1, fontFamily: "'DM Serif Display', serif" }}>
                          {stats.overallBand.toFixed(1)}
                        </div>
                      </div>
                    )}
                  </div>
                  {stats.testsCompleted === 0 ? (
                    <div className="sd-empty">
                      <i className="fas fa-chart-bar" />
                      <p>Complete tests to see your progress here</p>
                    </div>
                  ) : (
                    <SkillProgress stats={stats.skillStats} />
                  )}
                </div>

                {/* Recent Activity */}
                <div className="sd-card">
                  <div className="sd-card-header">
                    <span className="sd-card-title">Recent Activity</span>
                    <a href="/student/performance" className="sd-card-link">View All →</a>
                  </div>
                  {activities.length === 0 ? (
                    <div className="sd-empty">
                      <i className="fas fa-history" />
                      <p>No activity yet. Start your first test!</p>
                    </div>
                  ) : (
                    <div className="sd-activity-list">
                      {activities.slice(0, 3).map((a) => {
                        const skill = normalizeSkill(a.testSkill);
                        const pending = skill === 'writing' && a.status === 'pending';
                        return (
                          <div key={a.id} className="sd-activity-item">
                            <div className={`sd-activity-icon ${skillClass(skill)}`}>
                              <i className={skillIcon(skill)} />
                            </div>
                            <div className="sd-activity-body">
                              <div className="sd-activity-name">{a.testName}</div>
                              <div className="sd-activity-time">
                                {skill.charAt(0).toUpperCase() + skill.slice(1)}
                                {a.timeSpentMinutes ? ` · ${a.timeSpentMinutes} min` : ''}
                                {' · '}{timeAgo(a.date)}
                              </div>
                            </div>
                            {pending ? (
                              <span className="sd-activity-badge pending">Pending</span>
                            ) : a.score !== null ? (
                              <span className="sd-activity-score">Band {a.score.toFixed(1)}</span>
                            ) : (
                              <span className="sd-activity-badge graded">Done</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
