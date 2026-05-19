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

export async function fetchStudentClassName(studentEmail: string): Promise<string | null> {
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
      return data.name || data.code || classId;
    }

    const classQuery = await getDocs(query(collection(db, 'classes'), where('code', '==', classId)));
    if (!classQuery.empty) {
      const data = classQuery.docs[0].data();
      return data.name || data.code || classId;
    }
  } catch {
    return null;
  }

  return null;
}
