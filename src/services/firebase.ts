import { initializeApp, getApps, getApp } from 'firebase/app';
import { getStorage } from 'firebase/storage';

const normalizeFirebaseDomain = (value: string | undefined) =>
  value?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

const normalizeFirebaseStorageBucket = (value: string | undefined, projectId: string | undefined) => {
  const bucket = value?.trim();
  if (bucket) {
    return bucket.replace(/\.appspot\.com$/, '.firebasestorage.app');
  }

  return projectId ? `${projectId}.firebasestorage.app` : undefined;
};

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: normalizeFirebaseDomain(process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN),
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: normalizeFirebaseStorageBucket(
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  ),
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const firebaseStorage = getStorage(firebaseApp);
