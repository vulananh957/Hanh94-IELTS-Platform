'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import { deleteDoc, doc, getFirestore, updateDoc } from 'firebase/firestore';
import { firebaseApp } from '@/services/firebase';
import { clearAuthState } from '@/services/auth';
import {
  addManageUser,
  bulkImportStudents,
  createManageClass,
  getManageUsersData,
  invalidateManageUsersCache,
  type ManageUserRole,
  subscribeManageUsersRealtime,
  type ManageClassRecord,
  type ManageUserRecord,
} from '@/services/manage-users';
import '../teacher-dashboard.css';
import './manage-users.css';

type TabKey = 'classes' | 'students' | 'teachers' | 'testCreators';
type ModalFeedback = { type: 'success' | 'error' | 'info'; message: string };

export function ManageUsersContent() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [auth, setAuth] = useState<any>(null);
  const [users, setUsers] = useState<ManageUserRecord[]>([]);
  const [classes, setClasses] = useState<ManageClassRecord[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>('classes');
  const [searchTerm, setSearchTerm] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [activityFilter, setActivityFilter] = useState('');
  const [viewingClass, setViewingClass] = useState<ManageClassRecord | null>(null);
  const [editingClass, setEditingClass] = useState<ManageClassRecord | null>(null);
  const [editingClassName, setEditingClassName] = useState('');
  const [editingClassDescription, setEditingClassDescription] = useState('');
  const [deletingClass, setDeletingClass] = useState<ManageClassRecord | null>(null);
  const [isSavingClass, setIsSavingClass] = useState(false);
  const [isDeletingClass, setIsDeletingClass] = useState(false);
  const [processingStudentId, setProcessingStudentId] = useState<string | null>(null);
  const [movingStudent, setMovingStudent] = useState<ManageUserRecord | null>(null);
  const [movingFromClass, setMovingFromClass] = useState<ManageClassRecord | null>(null);
  const [moveTargetClassId, setMoveTargetClassId] = useState('');
  const [isMovingStudent, setIsMovingStudent] = useState(false);
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [showCreateClassModal, setShowCreateClassModal] = useState(false);
  const [showBulkImportModal, setShowBulkImportModal] = useState(false);
  const [addUserEmail, setAddUserEmail] = useState('');
  const [addUserRole, setAddUserRole] = useState<ManageUserRole>('student');
  const [addUserClassCode, setAddUserClassCode] = useState('');
  const [isAddingUser, setIsAddingUser] = useState(false);
  const [addUserFeedback, setAddUserFeedback] = useState<ModalFeedback | null>(null);
  const [newClassName, setNewClassName] = useState('');
  const [newClassDescription, setNewClassDescription] = useState('');
  const [isCreatingClass, setIsCreatingClass] = useState(false);
  const [createClassFeedback, setCreateClassFeedback] = useState<ModalFeedback | null>(null);
  const [bulkImportClassCode, setBulkImportClassCode] = useState('');
  const [bulkImportText, setBulkImportText] = useState('');
  const [isBulkImporting, setIsBulkImporting] = useState(false);
  const [bulkImportFeedback, setBulkImportFeedback] = useState<ModalFeedback | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const loadSeqRef = useRef(0);
  const hasAutoReloadedRef = useRef(false);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      setAuth(getAuth(firebaseApp));
    } catch (err) {
      setError('Failed to initialize authentication');
      console.error(err);
    }
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

  const loadData = async (options?: { showLoading?: boolean; forceFresh?: boolean }): Promise<boolean> => {
    if (!user?.email) return false;

    const { showLoading = true, forceFresh = false } = options || {};
    const seq = ++loadSeqRef.current;

    try {
      if (showLoading) setIsLoading(true);
      setError(null);

      if (forceFresh) {
        invalidateManageUsersCache(user.email);
      }

      const payload = await getManageUsersData(user.email, forceFresh);
      if (seq !== loadSeqRef.current) return false;

      setUsers(payload.users);
      setClasses(payload.classes);
      return true;
    } catch (err) {
      if (seq !== loadSeqRef.current) return false;
      setError(err instanceof Error ? err.message : 'Failed to load users data');
      return false;
    } finally {
      if (seq === loadSeqRef.current && showLoading) {
        setIsLoading(false);
      }
    }
  };

  const showActionFeedback = (type: 'success' | 'error', message: string) => {
    setActionFeedback({ type, message });
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }

    feedbackTimerRef.current = setTimeout(() => {
      setActionFeedback(null);
      feedbackTimerRef.current = null;
    }, 4200);
  };

  useEffect(() => {
    if (!user?.email) return;

    let active = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const unsubscribe = subscribeManageUsersRealtime(user.email, () => {
      if (!active) return;
      loadData({ showLoading: false, forceFresh: true });
    });

    loadData({ showLoading: true, forceFresh: false });

    intervalId = setInterval(() => {
      if (!active) return;
      loadData({ showLoading: false, forceFresh: true });
    }, 5 * 60 * 1000);

    return () => {
      active = false;
      unsubscribe();
      if (intervalId) clearInterval(intervalId);
    };
  }, [user?.email]);

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
    if (typeof window === 'undefined') return;

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const reasonText =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : String(reason);

      const isEventReason = reason instanceof Event || reasonText === '[object Event]';
      const isChunkLoadIssue = /Loading chunk|ChunkLoadError|Failed to fetch dynamically imported module/i.test(reasonText);

      if (!isEventReason && !isChunkLoadIssue) return;

      event.preventDefault();

      // During dev HMR, stale chunk/event rejections can temporarily break the page.
      // Reload once to recover fresh assets and keep the form usable.
      if (!hasAutoReloadedRef.current) {
        hasAutoReloadedRef.current = true;
        window.location.reload();
        return;
      }

      setError('The page assets were updated unexpectedly. Please refresh once to continue.');
    };

    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => window.removeEventListener('unhandledrejection', onUnhandledRejection);
  }, []);

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

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    };
  }, []);

  const classNameByCode = useMemo(() => {
    const map = new Map<string, string>();
    classes.forEach((c) => {
      map.set(c.id, c.name);
      if (c.code) map.set(c.code, c.name);
    });
    return map;
  }, [classes]);

  const stats = useMemo(() => {
    const teachers = users.filter((u) => u.role === 'teacher').length;
    const students = users.filter((u) => u.role === 'student').length;
    const testCreators = users.filter((u) => u.role === 'testCreator').length;
    return {
      teachers,
      students,
      testCreators,
      classes: classes.length,
    };
  }, [users, classes]);

  const filteredUsers = useMemo(() => {
    let list = [...users];

    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      list = list.filter((u) => String(u.name || '').toLowerCase().includes(q) || String(u.email || '').toLowerCase().includes(q));
    }

    if (classFilter) {
      list = list.filter((u) => {
        const code = u.classCode || u.classId || '';
        if (classFilter === 'no-class') return !code;
        return code === classFilter;
      });
    }

    if (activityFilter) {
      list = list.filter((u) => {
        const active = Boolean(u.lastLogin);
        if (activityFilter === 'recent') return active;
        if (activityFilter === 'inactive') return !active;
        return true;
      });
    }

    if (activeTab === 'students') {
      return list
        .filter((u) => u.role === 'student')
        .sort((a, b) => {
          const aClassKey = String(a.classCode || a.classId || '').trim();
          const bClassKey = String(b.classCode || b.classId || '').trim();

          const aHasClass = aClassKey.length > 0;
          const bHasClass = bClassKey.length > 0;
          if (aHasClass !== bHasClass) return aHasClass ? -1 : 1;

          const aClassName = aClassKey ? String(classNameByCode.get(aClassKey) || aClassKey) : '';
          const bClassName = bClassKey ? String(classNameByCode.get(bClassKey) || bClassKey) : '';
          const classCompare = aClassName.localeCompare(bClassName, 'en', { sensitivity: 'base' });
          if (classCompare !== 0) return classCompare;

          const aName = String(a.name || a.email || '');
          const bName = String(b.name || b.email || '');
          return aName.localeCompare(bName, 'en', { sensitivity: 'base' });
        });
    }
    if (activeTab === 'teachers') return list.filter((u) => u.role === 'teacher');
    if (activeTab === 'testCreators') return list.filter((u) => u.role === 'testCreator');
    return list;
  }, [users, searchTerm, classFilter, activityFilter, activeTab, classNameByCode]);

  const displayedClasses = useMemo(() => {
    if (!searchTerm.trim()) return classes;
    const q = searchTerm.toLowerCase();
    return classes.filter((c) => c.name.toLowerCase().includes(q) || (c.code || '').toLowerCase().includes(q));
  }, [classes, searchTerm]);

  const getStudentsForClass = (cls: ManageClassRecord): ManageUserRecord[] => {
    const classKey = cls.code || cls.id;
    return users.filter(
      (u) =>
        u.role === 'student' &&
        (u.classCode === classKey || u.classId === classKey || u.classCode === cls.id || u.classId === cls.id),
    );
  };

  const userInitials = useMemo(() => {
    if (!user) return 'T';
    if (user.displayName) {
      return user.displayName
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .toUpperCase();
    }
    return user.email?.split('@')[0].substring(0, 2).toUpperCase() || 'T';
  }, [user]);

  const handleRefresh = async () => {
    if (!user?.email || isRefreshing) return;

    try {
      setIsRefreshing(true);
      setError(null);
      const success = await loadData({ showLoading: true, forceFresh: true });
      if (success) {
        showActionFeedback('success', 'Manage users data refreshed successfully.');
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  const closeAddUserModal = () => {
    if (isAddingUser) return;
    setShowAddUserModal(false);
    setAddUserFeedback(null);
  };

  const closeCreateClassModal = () => {
    if (isCreatingClass) return;
    setShowCreateClassModal(false);
    setCreateClassFeedback(null);
  };

  const closeBulkImportModal = () => {
    if (isBulkImporting) return;
    setShowBulkImportModal(false);
    setBulkImportFeedback(null);
  };

  const openAddUserModal = (presetRole?: ManageUserRole) => {
    const roleFromTab: ManageUserRole = activeTab === 'teachers'
      ? 'teacher'
      : activeTab === 'testCreators'
        ? 'testCreator'
        : 'student';

    setAddUserEmail('');
    setAddUserRole(presetRole || roleFromTab);
    setAddUserClassCode('');
    setAddUserFeedback(null);
    setShowAddUserModal(true);
  };

  const openCreateClassModal = () => {
    setNewClassName('');
    setNewClassDescription('');
    setCreateClassFeedback(null);
    setShowCreateClassModal(true);
  };

  const openBulkImportModal = () => {
    setBulkImportClassCode('');
    setBulkImportText('');
    setBulkImportFeedback(null);
    setShowBulkImportModal(true);
  };

  const handleAddUserSubmit = async () => {
    if (isAddingUser) return;

    const email = addUserEmail.trim();
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    setAddUserFeedback(null);

    if (!email) {
      setAddUserFeedback({ type: 'error', message: 'Please enter an email address.' });
      return;
    }

    if (!emailPattern.test(email)) {
      setAddUserFeedback({ type: 'error', message: 'Please provide a valid email address.' });
      return;
    }

    if (addUserRole === 'student' && !addUserClassCode) {
      setAddUserFeedback({ type: 'error', message: 'Please assign a class for student accounts.' });
      return;
    }

    try {
      setIsAddingUser(true);

      const result = await addManageUser({
        email,
        role: addUserRole,
        classCode: addUserRole === 'student' ? addUserClassCode : null,
      });

      if (!result.success) {
        throw new Error(result.error || result.message || 'Failed to add user.');
      }

      const refreshed = await loadData({ showLoading: false, forceFresh: true });
      if (refreshed) {
        setAddUserEmail('');
        setAddUserClassCode('');
        setAddUserFeedback({ type: 'success', message: `${email} was added successfully as ${addUserRole}.` });
      } else {
        setAddUserFeedback({ type: 'success', message: `${email} was added. Please refresh if list is not updated yet.` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add user.';
      setAddUserFeedback({ type: 'error', message });
    } finally {
      setIsAddingUser(false);
    }
  };

  const handleCreateClassSubmit = async () => {
    if (isCreatingClass) return;

    const name = newClassName.trim();
    const description = newClassDescription.trim();
    setCreateClassFeedback(null);

    if (!name) {
      setCreateClassFeedback({ type: 'error', message: 'Please enter a class name.' });
      return;
    }

    try {
      setIsCreatingClass(true);

      const result = await createManageClass({ name, description });
      if (!result.success) {
        throw new Error(result.error || 'Failed to create class.');
      }

      const generatedCode = String(result.classCode || result.code || '').trim();
      const refreshed = await loadData({ showLoading: false, forceFresh: true });
      if (refreshed) {
        setNewClassName('');
        setNewClassDescription('');
        setCreateClassFeedback({
          type: 'success',
          message: generatedCode
            ? `Class "${name}" created successfully (code: ${generatedCode}).`
            : `Class "${name}" created successfully.`,
        });
      } else {
        setCreateClassFeedback({
          type: 'success',
          message: generatedCode
            ? `Class "${name}" created (code: ${generatedCode}). Please refresh if list is not updated yet.`
            : `Class "${name}" created. Please refresh if list is not updated yet.`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create class.';
      setCreateClassFeedback({ type: 'error', message });
    } finally {
      setIsCreatingClass(false);
    }
  };

  const handleBulkImportSubmit = async () => {
    if (isBulkImporting) return;

    const classCode = bulkImportClassCode.trim();
    setBulkImportFeedback(null);
    if (!classCode) {
      setBulkImportFeedback({ type: 'error', message: 'Please select a destination class.' });
      return;
    }

    const rawLines = bulkImportText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (rawLines.length === 0) {
      setBulkImportFeedback({ type: 'error', message: 'Please enter at least one student email.' });
      return;
    }

    const deduped = Array.from(new Set(rawLines.map((line) => line.toLowerCase())));
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidEmails = deduped.filter((email) => !emailPattern.test(email));

    if (invalidEmails.length > 0) {
      setBulkImportFeedback({ type: 'error', message: `Invalid email format: ${invalidEmails[0]}` });
      return;
    }

    try {
      setIsBulkImporting(true);

      const result = await bulkImportStudents({
        classCode,
        students: deduped.map((email) => ({ email, role: 'student' })),
      });

      if (!result.success) {
        throw new Error(result.error || result.message || 'Failed to import students.');
      }

      setActiveTab('students');
      setBulkImportText('');

      const refreshed = await loadData({ showLoading: false, forceFresh: true });
      if (refreshed) {
        const importedCount = result.addedCount ?? deduped.length;
        setBulkImportFeedback({ type: 'success', message: `Imported ${importedCount} student account(s) successfully.` });
      } else {
        setBulkImportFeedback({ type: 'success', message: 'Import completed. Please refresh if list is not updated yet.' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to import students.';
      setBulkImportFeedback({ type: 'error', message });
    } finally {
      setIsBulkImporting(false);
    }
  };

  const handleViewUser = (item: ManageUserRecord) => {
    const classKey = item.classCode || item.classId || '';
    const className = classKey ? classNameByCode.get(classKey) || classKey : 'No Class Assigned';
    const text = [
      `Name: ${String(item.name || 'Unknown')}`,
      `Email: ${String(item.email || '-')}`,
      `Role: ${String(item.role || 'user')}`,
      `Class: ${className}`,
      `Status: ${item.lastLogin ? 'Active' : 'Inactive'}`,
    ].join('\n');
    window.alert(text);
  };

  const handleEditUser = async (item: ManageUserRecord) => {
    const currentName = String(item.name || '');
    const currentRole = String(item.role || 'student');
    const currentClass = String(item.classCode || item.classId || '');

    const nextName = window.prompt('Edit user name:', currentName);
    if (nextName === null) return;

    const nextRoleRaw = window.prompt('Edit user role (teacher/student/testCreator):', currentRole);
    if (nextRoleRaw === null) return;
    const nextRole = nextRoleRaw.trim();
    if (!['teacher', 'student', 'testCreator'].includes(nextRole)) {
      setError('Invalid role. Use teacher, student, or testCreator.');
      return;
    }

    const nextClass = window.prompt('Edit class code/id (leave empty for no class):', currentClass);
    if (nextClass === null) return;

    try {
      const db = getFirestore(firebaseApp);
      await updateDoc(doc(db, 'users', item.id), {
        name: nextName.trim() || currentName,
        role: nextRole,
        classCode: nextClass.trim() || null,
        classId: nextClass.trim() || null,
      });
      await loadData({ showLoading: true, forceFresh: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    }
  };

  const handleDeleteUser = async (item: ManageUserRecord) => {
    const currentEmail = String(user?.email || '').trim().toLowerCase();
    const targetEmail = String(item.email || '').trim().toLowerCase();
    if (currentEmail && targetEmail && currentEmail === targetEmail) {
      setError('You cannot delete your own teacher account.');
      return;
    }

    const safeName = String(item.name || item.email || item.id || 'this user');
    const confirmed = window.confirm(`Delete user "${safeName}"?\n\nThis will remove the user record from the system.`);
    if (!confirmed) return;

    try {
      const db = getFirestore(firebaseApp);
      await deleteDoc(doc(db, 'users', item.id));
      await loadData({ showLoading: true, forceFresh: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    }
  };

  const handleOpenMoveStudentModal = (student: ManageUserRecord, currentClass?: ManageClassRecord | null) => {
    const availableClasses = classes.filter((cls) => (currentClass ? cls.id !== currentClass.id : true));
    if (availableClasses.length === 0) {
      setError('No other class available to move this student.');
      return;
    }

    setMovingStudent(student);
    setMovingFromClass(currentClass || null);
    setMoveTargetClassId('');
  };

  const handleConfirmMoveStudent = async () => {
    if (!movingStudent) return;
    if (!moveTargetClassId) {
      setError('Please select destination class.');
      return;
    }

    const targetClass = classes.find((cls) => cls.id === moveTargetClassId);
    if (!targetClass) {
      setError('Destination class not found.');
      return;
    }

    try {
      setIsMovingStudent(true);
      setProcessingStudentId(movingStudent.id);
      const db = getFirestore(firebaseApp);
      await updateDoc(doc(db, 'users', movingStudent.id), {
        classId: targetClass.id,
        classCode: targetClass.code || targetClass.id,
      });
      setMovingStudent(null);
      setMovingFromClass(null);
      setMoveTargetClassId('');
      await loadData({ showLoading: true, forceFresh: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move student');
    } finally {
      setIsMovingStudent(false);
      setProcessingStudentId(null);
    }
  };

  const handleCloseMoveStudentModal = () => {
    if (isMovingStudent) return;
    setMovingStudent(null);
    setMovingFromClass(null);
    setMoveTargetClassId('');
  };

  const findStudentCurrentClass = (student: ManageUserRecord): ManageClassRecord | null => {
    const classKey = String(student.classId || student.classCode || '').trim();
    if (!classKey) return null;
    return classes.find((cls) => cls.id === classKey || cls.code === classKey) || null;
  };

  const handleRemoveStudentFromClass = async (student: ManageUserRecord, currentClass: ManageClassRecord) => {
    const confirmed = window.confirm(
      `Remove ${String(student.name || student.email || 'this student')} from class "${String(currentClass.name || currentClass.id)}"?`,
    );

    if (!confirmed) return;

    try {
      setProcessingStudentId(student.id);
      const db = getFirestore(firebaseApp);
      await updateDoc(doc(db, 'users', student.id), {
        classId: null,
        classCode: null,
      });
      await loadData({ showLoading: true, forceFresh: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove student from class');
    } finally {
      setProcessingStudentId(null);
    }
  };

  const handleViewClass = (cls: ManageClassRecord) => {
    setViewingClass(cls);
  };

  const handleOpenEditClass = (cls: ManageClassRecord) => {
    setEditingClass(cls);
    setEditingClassName(String(cls.name || ''));
    setEditingClassDescription(String(cls.description || ''));
  };

  const handleSaveEditClass = async () => {
    if (!editingClass) return;
    const currentName = String(editingClass.name || '');

    try {
      setIsSavingClass(true);
      const db = getFirestore(firebaseApp);
      await updateDoc(doc(db, 'classes', editingClass.id), {
        name: editingClassName.trim() || currentName,
        description: editingClassDescription.trim() || '',
      });
      setEditingClass(null);
      await loadData({ showLoading: true, forceFresh: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update class');
    } finally {
      setIsSavingClass(false);
    }
  };

  const handleRequestDeleteClass = (cls: ManageClassRecord) => {
    setDeletingClass(cls);
  };

  const handleDeleteClass = async (classId: string, className: string) => {
    if (!user?.email) return;
    const safeClassId = String(classId || '').trim();
    const safeClassName = String(className || 'this class');
    if (!safeClassId) {
      setError('Invalid class id');
      return;
    }

    const confirmed = window.confirm(
      `Delete class "${safeClassName}"?\n\nThis will permanently remove the class and revoke access for all students in it.`,
    );

    if (!confirmed) return;

    try {
      setIsDeletingClass(true);
      const authInstance = getAuth(firebaseApp);
      const authUser = authInstance.currentUser;
      if (!authUser) throw new Error('User not authenticated');

      const idToken = await authUser.getIdToken();
      const response = await fetch('https://us-central1-hanh94esl-71776.cloudfunctions.net/deleteClass', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ classId: safeClassId }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Failed to delete class');
      }

      await loadData({ showLoading: true, forceFresh: true });
      setDeletingClass(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete class');
    } finally {
      setIsDeletingClass(false);
    }
  };

  const handleLogout = async () => {
    if (!confirm('Are you sure you want to logout?')) return;
    try {
      await signOut(auth);
      clearAuthState();
      router.push('/login');
    } catch (err) {
      console.error(err);
      clearAuthState();
      router.push('/login');
    }
  };

  const renderUsersTable = () => (
    <div className="table-container">
      <table className="data-table">
        <thead>
          <tr>
            <th>User</th>
            <th>{activeTab === 'students' ? 'Class' : 'Role'}</th>
            <th>Last Login</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filteredUsers.map((item) => {
            const classKey = item.classCode || item.classId || '';
            const className = classKey ? classNameByCode.get(classKey) || classKey : '';
            const safeName = String(item.name || item.email || 'Unknown');
            const safeEmail = String(item.email || '');
            const safeRole = String(item.role || 'user');
            const isTeacherTab = activeTab === 'teachers';
            const isSelfTeacher =
              isTeacherTab &&
              String(user?.email || '').trim().toLowerCase() !== '' &&
              String(user?.email || '').trim().toLowerCase() === safeEmail.trim().toLowerCase();
            return (
              <tr key={item.id}>
                <td>
                  <div className="user-info-cell">
                    <div className="user-avatar-small">
                      {item.photoURL ? <img src={item.photoURL} alt={safeName} /> : safeName.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="user-details">
                      <h4>{safeName}</h4>
                      <p>{safeEmail}</p>
                    </div>
                  </div>
                </td>
                <td>
                  {activeTab === 'students' ? (
                    className ? (
                      <>
                        <span className="class-main">{className}</span>
                        <div className="class-sub">{classKey.slice(0, 8).toUpperCase()}</div>
                      </>
                    ) : (
                      <span className="no-class">No Class Assigned</span>
                    )
                  ) : (
                    <span className={`role-badge ${safeRole}`}>{safeRole}</span>
                  )}
                </td>
                <td>
                  <span className={`status-badge ${item.lastLogin ? 'active' : 'inactive'}`}>
                    {item.lastLogin ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <div className="action-buttons">
                    <button className="btn-small btn-view" type="button" title="View" onClick={() => handleViewUser(item)}>
                      <i className="fas fa-eye" />
                    </button>
                    {!isTeacherTab ? (
                      <button
                        className="btn-small btn-edit"
                        type="button"
                        title={activeTab === 'students' ? 'Move class' : 'Edit'}
                        onClick={() => {
                          if (activeTab === 'students') {
                            handleOpenMoveStudentModal(item, findStudentCurrentClass(item));
                            return;
                          }
                          void handleEditUser(item);
                        }}
                      >
                        <i className={`fas ${activeTab === 'students' ? 'fa-exchange-alt' : 'fa-edit'}`} />
                      </button>
                    ) : null}
                    <button
                      className="btn-small btn-delete"
                      type="button"
                      title={isSelfTeacher ? 'You cannot delete your own account' : 'Delete'}
                      disabled={isSelfTeacher}
                      onClick={() => void handleDeleteUser(item)}
                    >
                      <i className="fas fa-trash" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="dashboard-container">
      <div className="left-edge-zone" onMouseEnter={() => setSidebarOpen(true)} />

      <aside ref={sidebarRef} className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="logo">hanh94esl</div>
          <div className="user-role">Smart Teacher Dashboard</div>
        </div>

        <nav className="sidebar-nav">
          <a href="/teacher" className="nav-item">
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
          <a href="/teacher/users" className="nav-item active">
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
            <h1 className="page-title">Manage Users</h1>
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
          <div className="user-management">
            <div className="management-header">
              <div className="header-left">
                <h1>User Management System</h1>
                <p className="header-subtitle">Manage teachers, students, test creators and classes</p>
              </div>
              <div className="header-actions">
                <button className="action-btn" type="button" onClick={() => openAddUserModal()}>
                  <i className="fas fa-user-plus" /> Add User
                </button>
                <button className="action-btn secondary" type="button" onClick={openCreateClassModal}>
                  <i className="fas fa-plus-circle" /> Create Class
                </button>
                <button className="action-btn secondary" type="button" onClick={openBulkImportModal}>
                  <i className="fas fa-file-import" /> Bulk Import
                </button>
                <button className="action-btn secondary" type="button" onClick={handleRefresh} disabled={isLoading || isRefreshing}>
                  <i className="fas fa-sync-alt" /> {isRefreshing ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>

            {actionFeedback ? (
              <div className={`action-feedback-banner ${actionFeedback.type}`} role="status">
                <i className={`fas ${actionFeedback.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-triangle'}`} />
                <span>{actionFeedback.message}</span>
                <button
                  type="button"
                  className="feedback-dismiss-btn"
                  aria-label="Dismiss message"
                  onClick={() => setActionFeedback(null)}
                >
                  <i className="fas fa-times" />
                </button>
              </div>
            ) : null}

            {error ? (
              <div className="content-section empty-state">
                <i className="fas fa-exclamation-triangle" />
                <h3>Failed to load data</h3>
                <p>{error}</p>
              </div>
            ) : null}

            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-icon teachers"><i className="fas fa-chalkboard-teacher" /></div>
                <div className="stat-number">{stats.teachers}</div>
                <div className="stat-label">Teachers</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon students"><i className="fas fa-user-graduate" /></div>
                <div className="stat-number">{stats.students}</div>
                <div className="stat-label">Students</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon test-creators"><i className="fas fa-edit" /></div>
                <div className="stat-number">{stats.testCreators}</div>
                <div className="stat-label">Test Creators</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon classes"><i className="fas fa-school" /></div>
                <div className="stat-number">{stats.classes}</div>
                <div className="stat-label">Classes</div>
              </div>
            </div>

            <div className="tab-navigation">
              <button className={`tab-btn ${activeTab === 'classes' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('classes')}>
                <i className="fas fa-school" /> Classes
              </button>
              <button className={`tab-btn ${activeTab === 'students' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('students')}>
                <i className="fas fa-user-graduate" /> Students
              </button>
              <button className={`tab-btn ${activeTab === 'teachers' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('teachers')}>
                <i className="fas fa-chalkboard-teacher" /> Teachers
              </button>
              <button className={`tab-btn ${activeTab === 'testCreators' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('testCreators')}>
                <i className="fas fa-edit" /> Test Creators
              </button>
            </div>

            <div className="controls-section">
              <div className="controls-header">
                <div className="controls-title">Search & Filter</div>
                <button className="action-btn secondary" type="button" onClick={() => {
                  setSearchTerm('');
                  setClassFilter('');
                  setActivityFilter('');
                }}>
                  <i className="fas fa-undo" /> Reset
                </button>
              </div>
              <div className="search-filter-grid">
                <div className="search-group">
                  <label className="form-label">Search</label>
                  <div className="search-input">
                    <i className="fas fa-search" />
                    <input className="form-input" placeholder="Search by name or email..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                  </div>
                </div>
                <div className="filter-group">
                  <label className="form-label">Class</label>
                  <select className="form-select" value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
                    <option value="">All Classes</option>
                    <option value="no-class">No Class</option>
                    {classes.map((cls) => (
                      <option key={cls.id} value={cls.code || cls.id}>{cls.name}</option>
                    ))}
                  </select>
                </div>
                <div className="filter-group">
                  <label className="form-label">Activity</label>
                  <select className="form-select" value={activityFilter} onChange={(e) => setActivityFilter(e.target.value)}>
                    <option value="">All</option>
                    <option value="recent">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
                <div className="action-group">
                  <button className="apply-btn" type="button" onClick={() => setSearchTerm((v) => v)}>
                    <i className="fas fa-filter" /> Apply
                  </button>
                </div>
              </div>
            </div>

            {isLoading ? (
              <div className="content-section loading-state">
                <div className="spinner" />
                <p>Loading data...</p>
              </div>
            ) : activeTab === 'classes' ? (
              <div className="content-section">
                <div className="section-header">
                  <div className="section-title">Classes Management</div>
                  <div className="header-actions">
                    <button className="action-btn secondary" type="button" onClick={openCreateClassModal}>
                      <i className="fas fa-plus" /> Create Class
                    </button>
                  </div>
                </div>
                {displayedClasses.length === 0 ? (
                  <div className="empty-state">
                    <i className="fas fa-school" />
                    <h3>No Classes Found</h3>
                    <p>Start by creating your first class.</p>
                  </div>
                ) : (
                  <div className="classes-container">
                    {displayedClasses.map((cls) => {
                      const classKey = cls.code || cls.id;
                      const studentCount = users.filter(
                        (u) =>
                          u.role === 'student' &&
                          (u.classCode === classKey || u.classId === classKey || u.classCode === cls.id || u.classId === cls.id),
                      ).length;

                      return (
                        <div key={cls.id} className="class-card">
                          <div className="class-card-header">
                            <div>
                              <h3 className="class-name">{cls.name}</h3>
                              <span className="class-code">{(cls.code || cls.id).slice(0, 8).toUpperCase()}</span>
                            </div>
                          </div>
                          <p className="class-description">{cls.description || 'No description provided'}</p>
                          <div className="class-stats">
                            <div className="class-student-count"><i className="fas fa-user-graduate" /> {studentCount} students</div>
                            <div className="class-actions">
                              <button
                                type="button"
                                className="btn-small btn-view"
                                title="View class details"
                                onClick={() => handleViewClass(cls)}
                              >
                                <i className="fas fa-eye" />
                              </button>
                              <button
                                type="button"
                                className="btn-small btn-edit"
                                title="Edit class"
                                onClick={() => handleOpenEditClass(cls)}
                              >
                                <i className="fas fa-edit" />
                              </button>
                              <button
                                type="button"
                                className="btn-small btn-delete"
                                title="Delete class"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  handleRequestDeleteClass(cls);
                                }}
                              >
                                <i className="fas fa-trash" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="content-section">
                <div className="section-header">
                  <div className="section-title">
                    {activeTab === 'students' && 'Students Management'}
                    {activeTab === 'teachers' && 'Teachers Management'}
                    {activeTab === 'testCreators' && 'Test Creators Management'}
                  </div>
                  <div className="header-actions">
                    {activeTab === 'students' && (
                      <button className="action-btn secondary" type="button" onClick={() => openAddUserModal('student')}>
                        <i className="fas fa-user-plus" /> Add Student
                      </button>
                    )}
                    {activeTab === 'teachers' && (
                      <button className="action-btn secondary" type="button" onClick={() => openAddUserModal('teacher')}>
                        <i className="fas fa-user-plus" /> Add Teacher
                      </button>
                    )}
                    {activeTab === 'testCreators' && (
                      <button className="action-btn secondary" type="button" onClick={() => openAddUserModal('testCreator')}>
                        <i className="fas fa-user-plus" /> Add Test Creator
                      </button>
                    )}
                  </div>
                </div>
                {filteredUsers.length === 0 ? (
                  <div className="empty-state">
                    <i className="fas fa-users" />
                    <h3>No Users Found</h3>
                    <p>No matching records for current filters.</p>
                  </div>
                ) : (
                  renderUsersTable()
                )}
              </div>
            )}
          </div>
        </div>
      </main>

      {showAddUserModal ? (
        <div className="manage-modal-overlay" role="dialog" aria-modal="true">
          <div className="manage-modal-content action-modal">
            <div className="manage-modal-header">
              <h3>Add New User</h3>
              <button type="button" className="manage-modal-close" onClick={closeAddUserModal} disabled={isAddingUser}>
                <i className="fas fa-times" />
              </button>
            </div>

            <div className="manage-modal-body">
              {isAddingUser ? (
                <div className="modal-inline-feedback info" role="status">
                  <i className="fas fa-spinner fa-spin" />
                  <span>Adding user... Please wait.</span>
                </div>
              ) : null}

              {addUserFeedback ? (
                <div className={`modal-inline-feedback ${addUserFeedback.type}`} role="status">
                  <i className={`fas ${addUserFeedback.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-triangle'}`} />
                  <span>{addUserFeedback.message}</span>
                </div>
              ) : null}

              <div className="edit-form-group">
                <label className="form-label">Email Address</label>
                <input
                  className="form-input"
                  type="email"
                  placeholder="user@example.com"
                  value={addUserEmail}
                  onChange={(e) => setAddUserEmail(e.target.value)}
                  disabled={isAddingUser}
                />
                <p className="edit-note">The system will automatically pull profile information from Google on first login.</p>
              </div>

              <div className="edit-form-group">
                <label className="form-label">Role</label>
                <select
                  className="form-select"
                  value={addUserRole}
                  onChange={(e) => {
                    setAddUserRole(e.target.value as ManageUserRole);
                    setAddUserClassCode('');
                  }}
                  disabled={isAddingUser}
                >
                  <option value="student">Student</option>
                  <option value="teacher">Teacher</option>
                  <option value="testCreator">Test Creator</option>
                </select>
              </div>

              {addUserRole === 'student' ? (
                <div className="edit-form-group">
                  <label className="form-label">Assign to Class</label>
                  <select
                    className="form-select"
                    value={addUserClassCode}
                    onChange={(e) => setAddUserClassCode(e.target.value)}
                    disabled={isAddingUser}
                  >
                    <option value="">Select class...</option>
                    {classes.map((cls) => {
                      const value = cls.code || cls.id;
                      return (
                        <option key={cls.id} value={value}>
                          {String(cls.name)} ({String(value).slice(0, 8).toUpperCase()})
                        </option>
                      );
                    })}
                  </select>
                  <p className="edit-note">Student accounts require a class assignment.</p>
                </div>
              ) : null}
            </div>

            <div className="manage-modal-footer">
              <button className="action-btn secondary" type="button" onClick={closeAddUserModal} disabled={isAddingUser}>
                Cancel
              </button>
              <button className="action-btn" type="button" onClick={() => void handleAddUserSubmit()} disabled={isAddingUser}>
                {isAddingUser ? 'Adding User...' : 'Add User'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showCreateClassModal ? (
        <div className="manage-modal-overlay" role="dialog" aria-modal="true">
          <div className="manage-modal-content action-modal">
            <div className="manage-modal-header">
              <h3>Create New Class</h3>
              <button type="button" className="manage-modal-close" onClick={closeCreateClassModal} disabled={isCreatingClass}>
                <i className="fas fa-times" />
              </button>
            </div>

            <div className="manage-modal-body">
              {isCreatingClass ? (
                <div className="modal-inline-feedback info" role="status">
                  <i className="fas fa-spinner fa-spin" />
                  <span>Creating class... Please wait.</span>
                </div>
              ) : null}

              {createClassFeedback ? (
                <div className={`modal-inline-feedback ${createClassFeedback.type}`} role="status">
                  <i className={`fas ${createClassFeedback.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-triangle'}`} />
                  <span>{createClassFeedback.message}</span>
                </div>
              ) : null}

              <div className="edit-form-group">
                <label className="form-label">Class Name</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="e.g., IELTS Advanced A1"
                  value={newClassName}
                  onChange={(e) => setNewClassName(e.target.value)}
                  disabled={isCreatingClass}
                />
                <p className="edit-note">Class code will be generated automatically and kept unique.</p>
              </div>

              <div className="edit-form-group">
                <label className="form-label">Description (Optional)</label>
                <textarea
                  className="edit-textarea"
                  placeholder="Brief description of this class..."
                  value={newClassDescription}
                  onChange={(e) => setNewClassDescription(e.target.value)}
                  disabled={isCreatingClass}
                />
              </div>
            </div>

            <div className="manage-modal-footer">
              <button className="action-btn secondary" type="button" onClick={closeCreateClassModal} disabled={isCreatingClass}>
                Cancel
              </button>
              <button className="action-btn" type="button" onClick={() => void handleCreateClassSubmit()} disabled={isCreatingClass}>
                {isCreatingClass ? 'Creating Class...' : 'Create Class'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showBulkImportModal ? (
        <div className="manage-modal-overlay" role="dialog" aria-modal="true">
          <div className="manage-modal-content bulk-import-modal">
            <div className="manage-modal-header">
              <h3>Bulk Import Students</h3>
              <button type="button" className="manage-modal-close" onClick={closeBulkImportModal} disabled={isBulkImporting}>
                <i className="fas fa-times" />
              </button>
            </div>

            <div className="manage-modal-body">
              {isBulkImporting ? (
                <div className="modal-inline-feedback info" role="status">
                  <i className="fas fa-spinner fa-spin" />
                  <span>Importing students... Please wait.</span>
                </div>
              ) : null}

              {bulkImportFeedback ? (
                <div className={`modal-inline-feedback ${bulkImportFeedback.type}`} role="status">
                  <i className={`fas ${bulkImportFeedback.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-triangle'}`} />
                  <span>{bulkImportFeedback.message}</span>
                </div>
              ) : null}

              <div className="edit-form-group">
                <label className="form-label">Assign to Class</label>
                <select
                  className="form-select"
                  value={bulkImportClassCode}
                  onChange={(e) => setBulkImportClassCode(e.target.value)}
                  disabled={isBulkImporting}
                >
                  <option value="">Select class...</option>
                  {classes.map((cls) => {
                    const value = cls.code || cls.id;
                    return (
                      <option key={cls.id} value={value}>
                        {String(cls.name)} ({String(value).slice(0, 8).toUpperCase()})
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="edit-form-group">
                <label className="form-label">Student Email List</label>
                <textarea
                  className="edit-textarea bulk-import-textarea"
                  placeholder={'student1@example.com\nstudent2@example.com\nstudent3@example.com'}
                  value={bulkImportText}
                  onChange={(e) => setBulkImportText(e.target.value)}
                  disabled={isBulkImporting}
                />
                <p className="edit-note">One email per line. Duplicate lines are ignored automatically.</p>
              </div>
            </div>

            <div className="manage-modal-footer">
              <button className="action-btn secondary" type="button" onClick={closeBulkImportModal} disabled={isBulkImporting}>
                Cancel
              </button>
              <button className="action-btn" type="button" onClick={() => void handleBulkImportSubmit()} disabled={isBulkImporting}>
                {isBulkImporting ? 'Importing Students...' : 'Import Students'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {viewingClass ? (
        <div className="manage-modal-overlay" role="dialog" aria-modal="true">
          <div className="manage-modal-content class-view-modal">
            <div className="manage-modal-header">
              <h3>{viewingClass.name}</h3>
              <button type="button" className="manage-modal-close" onClick={() => setViewingClass(null)}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="manage-modal-body">
              <div className="class-detail-summary">
                <div>
                  <span>Class Code:</span>
                  <strong>{(viewingClass.code || viewingClass.id).toUpperCase()}</strong>
                </div>
                <div>
                  <span>Total Students:</span>
                  <strong>{getStudentsForClass(viewingClass).length}</strong>
                </div>
                <div>
                  <span>Status:</span>
                  <strong className="active-text">Active</strong>
                </div>
              </div>

              <h4 className="class-students-title">Students in this class:</h4>
              <div className="class-students-table-wrap">
                <table className="class-students-table">
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {getStudentsForClass(viewingClass).length === 0 ? (
                      <tr>
                        <td colSpan={3} className="empty-row">No students in this class.</td>
                      </tr>
                    ) : (
                      getStudentsForClass(viewingClass).map((student) => {
                        const safeName = String(student.name || student.email || 'Student');
                        return (
                          <tr key={student.id}>
                            <td>
                              <div className="student-inline-cell">
                                <div className="user-avatar-small">
                                  {student.photoURL ? (
                                    <img src={student.photoURL} alt={safeName} />
                                  ) : (
                                    safeName.slice(0, 2).toUpperCase()
                                  )}
                                </div>
                                <div className="user-details">
                                  <h4>{safeName}</h4>
                                  <p>{student.email}</p>
                                </div>
                              </div>
                            </td>
                            <td>
                              <span className="status-badge active">active</span>
                            </td>
                            <td>
                              <div className="action-buttons">
                                <button
                                  className="btn-small btn-edit"
                                  type="button"
                                  title="Move student"
                                  disabled={processingStudentId === student.id}
                                  onClick={() => handleOpenMoveStudentModal(student, viewingClass)}
                                >
                                  <i className="fas fa-exchange-alt" />
                                </button>
                                <button
                                  className="btn-small btn-delete"
                                  type="button"
                                  title="Remove student"
                                  disabled={processingStudentId === student.id}
                                  onClick={() => void handleRemoveStudentFromClass(student, viewingClass)}
                                >
                                  <i className="fas fa-trash" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {editingClass ? (
        <div className="manage-modal-overlay" role="dialog" aria-modal="true">
          <div className="manage-modal-content class-edit-modal">
            <div className="manage-modal-header">
              <h3>Edit Class</h3>
              <button type="button" className="manage-modal-close" onClick={() => setEditingClass(null)}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="manage-modal-body">
              <div className="edit-form-group">
                <label className="form-label">Class Name</label>
                <input
                  className="form-input"
                  value={editingClassName}
                  onChange={(e) => setEditingClassName(e.target.value)}
                  placeholder="Enter class name"
                />
              </div>

              <div className="edit-form-group">
                <label className="form-label">Description (Optional)</label>
                <textarea
                  className="edit-textarea"
                  value={editingClassDescription}
                  onChange={(e) => setEditingClassDescription(e.target.value)}
                  placeholder="Enter class description"
                />
              </div>

              <div className="edit-form-group">
                <label className="form-label">Class Code</label>
                <input className="form-input" value={(editingClass.code || editingClass.id).toUpperCase()} readOnly disabled />
                <p className="edit-note">Class code cannot be changed for security reasons.</p>
              </div>
            </div>
            <div className="manage-modal-footer">
              <button className="action-btn secondary" type="button" onClick={() => setEditingClass(null)}>
                Cancel
              </button>
              <button className="action-btn" type="button" onClick={() => void handleSaveEditClass()} disabled={isSavingClass}>
                {isSavingClass ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deletingClass ? (
        <div className="manage-modal-overlay" role="dialog" aria-modal="true">
          <div className="manage-modal-content delete-warning-modal">
            <div className="manage-modal-header">
              <h3>Delete Class "{deletingClass.name}"?</h3>
              <button type="button" className="manage-modal-close" onClick={() => setDeletingClass(null)}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="manage-modal-body">
              <p>This class has {getStudentsForClass(deletingClass).length} students.</p>
              <p className="warning-text">WARNING: This will permanently delete:</p>
              <ul className="warning-list">
                <li>All student access in this class</li>
                <li>Related test attempts and scores</li>
                <li>Related writing submissions</li>
                <li>Class access on the platform</li>
              </ul>
            </div>
            <div className="manage-modal-footer">
              <button className="action-btn secondary" type="button" onClick={() => setDeletingClass(null)}>
                Cancel
              </button>
              <button
                className="action-btn delete-cta"
                type="button"
                disabled={isDeletingClass}
                onClick={() => void handleDeleteClass(String(deletingClass.id || ''), String(deletingClass.name || ''))}
              >
                {isDeletingClass ? 'Deleting...' : 'Delete Class'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {movingStudent ? (
        <div className="manage-modal-overlay move-student-overlay" role="dialog" aria-modal="true">
          <div className="manage-modal-content move-student-modal">
            <div className="manage-modal-header">
              <h3>
                <i className="fas fa-exchange-alt" /> Move Student
              </h3>
              <button type="button" className="manage-modal-close" onClick={handleCloseMoveStudentModal}>
                <i className="fas fa-times" />
              </button>
            </div>

            <div className="manage-modal-body">
              <div className="student-move-card">
                <div className="student-move-avatar">
                  {movingStudent.photoURL ? (
                    <img src={movingStudent.photoURL} alt={String(movingStudent.name || movingStudent.email || 'Student')} />
                  ) : (
                    String(movingStudent.name || movingStudent.email || 'Student')
                      .split(' ')
                      .map((part) => part[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase()
                  )}
                </div>
                <div className="student-move-info">
                  <h4>{String(movingStudent.name || 'Student')}</h4>
                  <p>{String(movingStudent.email || '')}</p>
                  <span>Current: {movingFromClass ? String(movingFromClass.name || movingFromClass.id) : 'No Class'}</span>
                </div>
              </div>

              <div className="edit-form-group">
                <label className="form-label">Move to Class:</label>
                <select
                  className="form-select"
                  value={moveTargetClassId}
                  onChange={(e) => setMoveTargetClassId(e.target.value)}
                  disabled={isMovingStudent}
                >
                  <option value="">Select destination class...</option>
                  {classes
                    .filter((cls) => (movingFromClass ? cls.id !== movingFromClass.id : true))
                    .map((cls) => {
                      const code = String(cls.code || cls.id).toUpperCase();
                      return (
                        <option key={cls.id} value={cls.id}>
                          {String(cls.name)} ({code})
                        </option>
                      );
                    })}
                </select>
              </div>
            </div>

            <div className="manage-modal-footer">
              <button className="action-btn secondary" type="button" onClick={handleCloseMoveStudentModal} disabled={isMovingStudent}>
                Cancel
              </button>
              <button className="action-btn" type="button" onClick={() => void handleConfirmMoveStudent()} disabled={isMovingStudent || !moveTargetClassId}>
                {isMovingStudent ? 'Moving...' : 'Move Student'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
