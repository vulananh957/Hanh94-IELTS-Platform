'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { signOutUser } from '@/services/auth';
import { firebaseApp } from '@/services/firebase';
import { fetchStudentClassName } from '@/services/student-profile';
import '../student-dashboard.css';
import './settings.css';

export function SettingsContent() {
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
    if (!window.confirm('Are you sure you want to logout?')) return;
    try {
      await signOutUser();
      router.replace('/login');
    } catch {
      window.alert('Unable to sign out. Please try again.');
    }
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

  return (
    <div className="sd-container st-page">
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
          <a href="/student/assignments" className="sd-nav-item">
            <i className="fas fa-tasks" /><span>Assignments</span>
          </a>
          <a href="/student/performance" className="sd-nav-item">
            <i className="fas fa-chart-line" /><span>Performance</span>
          </a>
          <a href="/student/settings" className="sd-nav-item active">
            <i className="fas fa-cog" /><span>Settings</span>
          </a>
          <button type="button" onClick={handleLogout} className="sd-nav-item" style={{ marginTop: 'auto' }}>
            <i className="fas fa-sign-out-alt" /><span>Logout</span>
          </button>
        </nav>
      </aside>

      <main className="sd-main">
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
            <h1 className="sd-page-title">Settings</h1>
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

        <div className="sd-content">
          <section className="sd-card st-placeholder">
            <p>đang bận quá, chưa làm được setting</p>
          </section>
        </div>
      </main>
    </div>
  );
}
