'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import { firebaseApp } from '@/services/firebase';
import { UploadTestWorkbench } from '../../../../features/upload-test/components/upload-test-workbench';
import '../teacher-dashboard.css';
import './upload-placeholder.css';

type TeacherUser = {
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
};

export function TeacherUploadPlaceholderContent() {
  const router = useRouter();
  const sidebarRef = useRef<HTMLElement | null>(null);
  const auth = useMemo(() => getAuth(firebaseApp), []);

  const [user, setUser] = useState<TeacherUser | null>(() => auth.currentUser);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (!auth) return;

    const unsub = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) {
        setUser(null);
        router.replace('/login');
        return;
      }

      setUser(currentUser);
    });

    return () => unsub();
  }, [auth, router]);

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

  if (!user) {
    return null;
  }

  return (
    <div className="dashboard-container upload-page">
      <div className="left-edge-zone" onMouseEnter={() => setSidebarOpen(true)} />
      <div className="upload-page-orb upload-page-orb-one" />
      <div className="upload-page-orb upload-page-orb-two" />

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
          <a href="/teacher/upload" className="nav-item active">
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
        <div className="top-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarOpen((value) => !value)}
              title="Toggle Sidebar"
              aria-label="Toggle Sidebar"
            >
              <i className="fas fa-bars" />
            </button>
            <h1 className="page-title">Upload Test</h1>
          </div>

          <div className="user-info">
            <div className="user-avatar">
              {user?.photoURL ? (
                <Image
                  src={user.photoURL}
                  alt={user.displayName || 'Teacher'}
                  width={45}
                  height={45}
                  unoptimized
                />
              ) : (
                <span>{userInitials}</span>
              )}
            </div>
            <div className="user-details">
              <h4>{user?.displayName || user?.email?.split('@')[0] || 'Teacher'}</h4>
              <p>IELTS Teacher</p>
            </div>
            <button type="button" className="logout-btn" onClick={handleLogout}>
              <i className="fas fa-sign-out-alt" /> Logout
            </button>
          </div>
        </div>

        <div className="content-area">
          <section className="upload-workbench-shell">
            <UploadTestWorkbench />
          </section>
        </div>
      </main>
    </div>
  );
}
