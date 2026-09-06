'use client';

import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  where,
} from 'firebase/firestore';
import { firebaseApp } from './firebase';

type StudentClass = {
  id: string;
  displayName: string | null;
};

async function fetchStudentClass(studentEmail: string): Promise<StudentClass | null> {
  if (!studentEmail) return null;

  const db = getFirestore(firebaseApp);
  const userSnap = await getDoc(doc(db, 'users', studentEmail)).catch(() => null);
  const userData = userSnap?.exists() ? userSnap.data() : null;
  const classId = userData?.classId || userData?.classCode || null;

  if (!classId) return null;

  try {
    const classSnap = await getDoc(doc(db, 'classes', classId));
    if (classSnap.exists()) {
      const data = classSnap.data();
      return { id: classSnap.id, displayName: data.name || data.code || null };
    }

    const classQuery = await getDocs(query(collection(db, 'classes'), where('code', '==', classId)));
    if (!classQuery.empty) {
      const classDoc = classQuery.docs[0];
      const data = classDoc.data();
      return { id: classDoc.id, displayName: data.name || data.code || null };
    }
  } catch {
    return null;
  }

  return null;
}

export async function fetchStudentClassName(studentEmail: string): Promise<string | null> {
  const studentClass = await fetchStudentClass(studentEmail);
  return studentClass?.displayName || studentClass?.id || null;
}

export async function fetchStudentClassDisplayName(studentEmail: string): Promise<string | null> {
  return (await fetchStudentClass(studentEmail))?.displayName || null;
}
