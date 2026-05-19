import { getApps, initializeApp } from 'firebase-admin/app';

export const firebaseAdminApp = getApps().length ? getApps()[0] : initializeApp();