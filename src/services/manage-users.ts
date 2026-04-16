import {
  collection,
  getDocs,
  getFirestore,
  onSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { firebaseApp } from './firebase';

export interface ManageUserRecord {
  id: string;
  email: string;
  name: string;
  role: 'teacher' | 'student' | 'testCreator' | string;
  classCode?: string;
  classId?: string;
  lastLogin?: unknown;
  photoURL?: string;
}

export interface ManageClassRecord {
  id: string;
  code?: string;
  name: string;
  description?: string;
}

export interface ManageUsersPayload {
  users: ManageUserRecord[];
  classes: ManageClassRecord[];
}

export type ManageUserRole = 'teacher' | 'student' | 'testCreator';

export interface AddManageUserInput {
  email: string;
  role: ManageUserRole;
  classCode?: string | null;
}

export interface AddManageUserResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface CreateManageClassInput {
  name: string;
  description?: string;
}

export interface CreateManageClassResponse {
  success: boolean;
  classCode?: string;
  code?: string;
  error?: string;
}

export interface BulkImportStudentInput {
  email: string;
  role?: 'student';
}

export interface BulkImportStudentsInput {
  classCode: string;
  students: BulkImportStudentInput[];
}

export interface BulkImportStudentsResponse {
  success: boolean;
  message?: string;
  error?: string;
  addedCount?: number;
}

const CACHE_DURATION = 60 * 1000;
const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'hanh94esl-71776';
const USE_EMULATOR = process.env.NEXT_PUBLIC_USE_FUNCTIONS_EMULATOR === 'true';
const FUNCTIONS_BASE_URL = USE_EMULATOR
  ? `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`
  : `https://us-central1-${PROJECT_ID}.cloudfunctions.net`;
const requestMap = new Map<string, Promise<ManageUsersPayload>>();

function toStringSafe(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function getCacheKeys(email: string) {
  const key = `manage_users_${email}`;
  return { key, timeKey: `${key}_time` };
}

function getTokenFromStorageBag(bag: Storage): string | null {
  const key = Object.keys(bag).find((item) => item.startsWith('firebase:authUser'));
  if (!key) return null;

  try {
    const raw = bag.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { stsTokenManager?: { accessToken?: string } };
    return parsed?.stsTokenManager?.accessToken || null;
  } catch {
    return null;
  }
}

async function getIdToken(): Promise<string> {
  const auth = getAuth(firebaseApp);

  if (auth.currentUser) {
    return auth.currentUser.getIdToken();
  }

  if (typeof window !== 'undefined') {
    const localToken = getTokenFromStorageBag(localStorage);
    if (localToken) return localToken;

    const sessionToken = getTokenFromStorageBag(sessionStorage);
    if (sessionToken) return sessionToken;
  }

  throw new Error('Unable to find Firebase ID token. Please sign in again.');
}

async function callManageUsersFunction<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const token = await getIdToken();

  const response = await fetch(`${FUNCTIONS_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text().catch(() => '');
  let parsed = {} as T;

  if (text) {
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      parsed = {} as T;
    }
  }

  if (!response.ok) {
    const fallback = text || `Cloud Function ${path} failed (${response.status})`;
    const reason = typeof parsed === 'object' && parsed !== null && 'error' in parsed
      ? String((parsed as { error?: unknown }).error || fallback)
      : fallback;
    throw new Error(reason);
  }

  return parsed;
}

export async function addManageUser(input: AddManageUserInput): Promise<AddManageUserResponse> {
  return callManageUsersFunction<AddManageUserResponse>('/addUser', {
    email: input.email,
    role: input.role,
    classCode: input.role === 'student' ? (input.classCode || null) : null,
  });
}

export async function createManageClass(input: CreateManageClassInput): Promise<CreateManageClassResponse> {
  return callManageUsersFunction<CreateManageClassResponse>('/createClass', {
    name: input.name,
    description: input.description || '',
  });
}

export async function bulkImportStudents(input: BulkImportStudentsInput): Promise<BulkImportStudentsResponse> {
  return callManageUsersFunction<BulkImportStudentsResponse>('/bulkImportStudents', {
    classCode: input.classCode,
    students: input.students.map((student) => ({
      email: student.email,
      role: 'student',
    })),
  });
}

export function invalidateManageUsersCache(email: string): void {
  const { key, timeKey } = getCacheKeys(email);
  if (typeof window !== 'undefined') {
    localStorage.removeItem(key);
    localStorage.removeItem(timeKey);
  }
  requestMap.delete(email);
}

export async function getManageUsersData(
  email: string,
  forceFresh = false,
): Promise<ManageUsersPayload> {
  const requestKey = email;
  if (!forceFresh && requestMap.has(requestKey)) {
    return requestMap.get(requestKey)!;
  }

  const db = getFirestore(firebaseApp);
  const { key, timeKey } = getCacheKeys(email);

  if (!forceFresh && typeof window !== 'undefined') {
    const cached = localStorage.getItem(key);
    const cachedTime = localStorage.getItem(timeKey);
    if (cached && cachedTime && Date.now() - Number(cachedTime) < CACHE_DURATION) {
      return JSON.parse(cached) as ManageUsersPayload;
    }
  }

  const promise = (async () => {
    const [usersSnapshot, classesSnapshot] = await Promise.all([
      getDocs(collection(db, 'users')),
      getDocs(collection(db, 'classes')),
    ]);

    const users: ManageUserRecord[] = usersSnapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const role = toStringSafe(data.role, 'student') || 'student';
      const emailValue = toStringSafe(data.email, '');
      const nameValue =
        toStringSafe(data.name, '') ||
        toStringSafe(data.displayName, '') ||
        (emailValue ? emailValue.split('@')[0] : 'Unknown');

      return {
        id: doc.id,
        email: emailValue,
        name: nameValue,
        role,
        classCode: toStringSafe(data.classCode, '') || undefined,
        classId: toStringSafe(data.classId, '') || undefined,
        lastLogin: data.lastLogin,
        photoURL: toStringSafe(data.photoURL, '') || undefined,
      };
    });

    const classes: ManageClassRecord[] = classesSnapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return {
        id: doc.id,
        code: toStringSafe(data.code, '') || undefined,
        name: (toStringSafe(data.name, `Class ${doc.id.slice(0, 8)}`) || `Class ${doc.id.slice(0, 8)}`).trim(),
        description: toStringSafe(data.description, '') || undefined,
      };
    });

    const payload = { users, classes };

    if (typeof window !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(payload));
      localStorage.setItem(timeKey, Date.now().toString());
    }

    return payload;
  })();

  requestMap.set(requestKey, promise);
  try {
    return await promise;
  } finally {
    requestMap.delete(requestKey);
  }
}

export function subscribeManageUsersRealtime(
  email: string,
  onChange: () => void,
): Unsubscribe {
  const db = getFirestore(firebaseApp);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let usersInitial = true;
  let classesInitial = true;

  const schedule = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      invalidateManageUsersCache(email);
      onChange();
    }, 180);
  };

  const unsubUsers = onSnapshot(collection(db, 'users'), () => {
    if (usersInitial) {
      usersInitial = false;
      return;
    }
    schedule();
  });

  const unsubClasses = onSnapshot(collection(db, 'classes'), () => {
    if (classesInitial) {
      classesInitial = false;
      return;
    }
    schedule();
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    unsubUsers();
    unsubClasses();
  };
}
