'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { firebaseApp } from '@/services/firebase';
import { useUploadTestStore } from '../store/use-upload-test-store';
import { EditTestWorkbench } from './edit-test-workbench';

interface EditTestPageProps {
  testId: string;
}

export function EditTestPage({ testId }: EditTestPageProps) {
  const router = useRouter();
  const loadExistingTest = useUploadTestStore((s) => s.loadExistingTest);
  const resetDraft = useUploadTestStore((s) => s.resetDraft);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const db = getFirestore(firebaseApp);
        const snap = await getDoc(doc(db, 'tests', testId));

        if (!snap.exists()) {
          if (!cancelled) {
            setError('Test not found. It may have been deleted.');
            setLoading(false);
          }
          return;
        }

        const data = { id: snap.id, ...snap.data() };
        loadExistingTest(data);

        if (!cancelled) {
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load test.');
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [testId, loadExistingTest]);

  const handleClose = () => {
    resetDraft();
    router.push('/teacher/tests');
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ width: 40, height: 40, border: '3px solid #e5e7eb', borderTop: '3px solid #3b82f6', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <p>Loading test data…</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: '1rem' }}>
        <p style={{ color: '#ef4444' }}>{error}</p>
        <button onClick={handleClose} style={{ padding: '0.5rem 1rem', background: '#3b82f6', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
          Back to Test Hub
        </button>
      </div>
    );
  }

  return <EditTestWorkbench testId={testId} onClose={handleClose} />;
}
