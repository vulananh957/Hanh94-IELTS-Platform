import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from 'firebase-admin/auth';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { firebaseAdminApp } from '@/services/firebase-admin';

export const runtime = 'nodejs';

type ManagedUserRole = 'teacher' | 'student' | 'testCreator';

type UserManagementBody =
  | {
      action: 'addUser';
      email: string;
      role: ManagedUserRole;
      classCode?: string | null;
    }
  | {
      action: 'syncLogin';
      email: string;
      role: ManagedUserRole;
      displayName?: string | null;
      photoURL?: string | null;
      classCode?: string | null;
    }
  | {
      action: 'updateUser';
      email: string;
      name: string;
      role: ManagedUserRole;
      classCode?: string | null;
      classId?: string | null;
    }
  | {
      action: 'disableUser';
      email: string;
    }
  | {
      action: 'moveStudent';
      email: string;
      targetClassId: string;
      targetClassCode?: string | null;
    }
  | {
      action: 'removeStudentFromClass';
      email: string;
    };

function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeRole(value: unknown): ManagedUserRole | null {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'teacher') return 'teacher';
  if (normalized === 'student') return 'student';
  if (normalized === 'testcreator' || normalized === 'test_creator' || normalized === 'creator') {
    return 'testCreator';
  }
  return null;
}

function isPrivilegedRole(role: ManagedUserRole | null): boolean {
  return role === 'teacher' || role === 'testCreator';
}

async function getBearerToken(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

async function findUserDocRef(email: string) {
  const db = getFirestore(firebaseAdminApp);
  const normalizedEmail = normalizeEmail(email);
  const candidateIds = Array.from(
    new Set([normalizeText(email), normalizedEmail].filter(Boolean)),
  );

  for (const candidateId of candidateIds) {
    const ref = db.collection('users').doc(candidateId);
    const snap = await ref.get();
    if (snap.exists) {
      return { ref, snap };
    }
  }

  for (const candidateEmail of candidateIds) {
    const querySnap = await db.collection('users').where('email', '==', candidateEmail).limit(1).get();
    if (!querySnap.empty) {
      const snap = querySnap.docs[0];
      return { ref: snap.ref, snap };
    }
  }

  return null;
}

async function resolveClassDocRef(classId: string, classCode?: string | null) {
  const db = getFirestore(firebaseAdminApp);
  const candidateValues = Array.from(
    new Set([normalizeText(classId), normalizeText(classCode)].filter(Boolean)),
  );

  for (const candidate of candidateValues) {
    const ref = db.collection('classes').doc(candidate);
    const snap = await ref.get();
    if (snap.exists) {
      return { ref, snap };
    }
  }

  for (const candidate of candidateValues) {
    const querySnap = await db.collection('classes').where('code', '==', candidate).limit(1).get();
    if (!querySnap.empty) {
      const snap = querySnap.docs[0];
      return { ref: snap.ref, snap };
    }
  }

  return null;
}

async function getRequesterRole(email: string): Promise<ManagedUserRole | null> {
  const userRef = await findUserDocRef(email);
  if (!userRef) {
    return null;
  }

  const data = userRef.snap.data() as Record<string, unknown> | undefined;
  return normalizeRole(data?.role);
}

function isSoftDisabledUser(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;

  const status = normalizeText(data.status).toLowerCase();
  return (
    status === 'disabled'
    || status === 'deleted'
    || status === 'inactive'
    || data.isActive === false
    || data.disabled === true
    || Boolean(data.deletedAt)
    || Boolean(data.removedAt)
  );
}

export async function POST(request: NextRequest) {
  try {
    const token = await getBearerToken(request);
    if (!token) {
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    const decoded = await getAuth(firebaseAdminApp).verifyIdToken(token);
    const requesterEmail = normalizeEmail(decoded.email);
    if (!requesterEmail) {
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    const body = (await request.json()) as Record<string, unknown> & { action?: string };
    const action = normalizeText(body.action);
    const db = getFirestore(firebaseAdminApp);

    if (action === 'syncLogin') {
      const targetEmail = normalizeEmail(body.email || requesterEmail);
      if (!targetEmail || targetEmail !== requesterEmail) {
        return NextResponse.json({ success: false, error: 'Forbidden.' }, { status: 403 });
      }

      const requestedRole = normalizeRole(body.role);
      if (!requestedRole) {
        return NextResponse.json({ success: false, error: 'Invalid role.' }, { status: 400 });
      }

      const existing = await findUserDocRef(targetEmail);
      const userRef = existing?.ref ?? db.collection('users').doc(targetEmail);
      const currentData = existing?.snap.data() as Record<string, unknown> | undefined;
      const timestamp = Timestamp.now();

      await userRef.set({
        email: targetEmail,
        name: normalizeText(body.displayName) || normalizeText(currentData?.name) || normalizeText(decoded.name) || targetEmail.split('@')[0],
        displayName: normalizeText(body.displayName) || normalizeText(currentData?.displayName) || normalizeText(decoded.name) || null,
        photoURL: normalizeText(body.photoURL) || normalizeText(currentData?.photoURL) || normalizeText(decoded.picture) || null,
        role: normalizeRole(currentData?.role) ?? requestedRole,
        classCode: normalizeText(body.classCode) || normalizeText(currentData?.classCode) || null,
        lastLogin: timestamp,
        lastLoginAt: timestamp,
        updatedAt: timestamp,
      }, { merge: true });

      return NextResponse.json({ success: true });
    }

    if (action === 'addUser') {
      const targetEmail = normalizeEmail(body.email);
      if (!targetEmail) {
        return NextResponse.json({ success: false, error: 'Missing user email.' }, { status: 400 });
      }

      const requestedRole = normalizeRole(body.role);
      if (!requestedRole) {
        return NextResponse.json({ success: false, error: 'Invalid role.' }, { status: 400 });
      }

      const existing = await findUserDocRef(targetEmail);
      const currentData = existing?.snap.data() as Record<string, unknown> | undefined;
      const isDisabled = isSoftDisabledUser(currentData);

      if (existing && !isDisabled) {
        return NextResponse.json({ success: false, error: 'user-already-exists' }, { status: 409 });
      }

      const timestamp = Timestamp.now();
      const userRef = existing?.ref ?? db.collection('users').doc(targetEmail);
      const targetClassCode = normalizeText(body.classCode) || normalizeText(currentData?.classCode) || null;
      const targetClass = requestedRole === 'student' && targetClassCode
        ? await resolveClassDocRef(targetClassCode, targetClassCode)
        : null;

      await userRef.set({
        email: targetEmail,
        name: normalizeText(currentData?.name) || targetEmail.split('@')[0],
        displayName: normalizeText(currentData?.displayName) || null,
        photoURL: normalizeText(currentData?.photoURL) || null,
        role: requestedRole,
        classCode: requestedRole === 'student'
          ? (normalizeText(targetClass?.snap.data()?.code) || targetClass?.snap.id || targetClassCode || null)
          : null,
        classId: requestedRole === 'student'
          ? (targetClass?.snap.id || normalizeText(currentData?.classId) || null)
          : null,
        status: 'active',
        accountStatus: 'active',
        isActive: true,
        disabled: false,
        deletedAt: null,
        removedAt: null,
        updatedAt: timestamp,
      }, { merge: true });

      return NextResponse.json({ success: true, restored: Boolean(existing) });
    }

    const requesterRole = await getRequesterRole(requesterEmail);
    if (!isPrivilegedRole(requesterRole)) {
      return NextResponse.json({ success: false, error: 'Forbidden.' }, { status: 403 });
    }

    if (action === 'updateUser') {
      const targetEmail = normalizeEmail(body.email);
      if (!targetEmail) {
        return NextResponse.json({ success: false, error: 'Missing user email.' }, { status: 400 });
      }

      const existing = await findUserDocRef(targetEmail);
      if (!existing) {
        return NextResponse.json({ success: false, error: 'User not found.' }, { status: 404 });
      }

      const timestamp = Timestamp.now();
      await existing.ref.set({
        name: normalizeText(body.name),
        displayName: normalizeText(body.name),
        role: normalizeRole(body.role) ?? 'student',
        classCode: normalizeText(body.classCode) || null,
        classId: normalizeText(body.classId) || null,
        updatedAt: timestamp,
      }, { merge: true });

      return NextResponse.json({ success: true });
    }

    if (action === 'disableUser') {
      const targetEmail = normalizeEmail(body.email);
      if (!targetEmail) {
        return NextResponse.json({ success: false, error: 'Missing user email.' }, { status: 400 });
      }

      const existing = await findUserDocRef(targetEmail);
      if (!existing) {
        return NextResponse.json({ success: false, error: 'User not found.' }, { status: 404 });
      }

      const timestamp = Timestamp.now();
      await existing.ref.set({
        status: 'disabled',
        accountStatus: 'disabled',
        isActive: false,
        disabled: true,
        classCode: null,
        classId: null,
        disabledAt: timestamp,
        updatedAt: timestamp,
      }, { merge: true });

      return NextResponse.json({ success: true });
    }

    if (action === 'moveStudent') {
      const targetEmail = normalizeEmail(body.email);
      const targetClassId = normalizeText(body.targetClassId);
      if (!targetEmail || !targetClassId) {
        return NextResponse.json({ success: false, error: 'Missing student or class information.' }, { status: 400 });
      }

      const existing = await findUserDocRef(targetEmail);
      if (!existing) {
        return NextResponse.json({ success: false, error: 'User not found.' }, { status: 404 });
      }

      const targetClass = await resolveClassDocRef(targetClassId, normalizeText(body.targetClassCode) || null);
      if (!targetClass) {
        return NextResponse.json({ success: false, error: 'Destination class not found.' }, { status: 404 });
      }

      const targetClassData = targetClass.snap.data() as Record<string, unknown> | undefined;
      const timestamp = Timestamp.now();
      await existing.ref.set({
        classId: targetClass.snap.id,
        classCode: normalizeText(targetClassData?.code) || normalizeText(body.targetClassCode) || targetClass.snap.id,
        updatedAt: timestamp,
      }, { merge: true });

      return NextResponse.json({ success: true });
    }

    if (action === 'removeStudentFromClass') {
      const targetEmail = normalizeEmail(body.email);
      if (!targetEmail) {
        return NextResponse.json({ success: false, error: 'Missing student email.' }, { status: 400 });
      }

      const existing = await findUserDocRef(targetEmail);
      if (!existing) {
        return NextResponse.json({ success: false, error: 'User not found.' }, { status: 404 });
      }

      await existing.ref.set({
        classId: null,
        classCode: null,
        updatedAt: Timestamp.now(),
      }, { merge: true });

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Unsupported action.' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error.';
    console.error('[user-management API]', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}