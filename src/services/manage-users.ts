import {
  collection,
  getDocs,
  getFirestore,
  onSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
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

const CACHE_DURATION = 60 * 1000;
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
