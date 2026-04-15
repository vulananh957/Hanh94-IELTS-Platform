import { getFirestore } from 'firebase/firestore';
import { firebaseApp } from './firebase';

export const db = getFirestore(firebaseApp);

export async function pingFirestore(): Promise<boolean> {
  return !!db;
}
