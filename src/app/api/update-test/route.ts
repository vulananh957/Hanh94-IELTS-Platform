import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { firebaseAdminApp } from '@/services/firebase-admin';
import { generateAnswerKey } from '@/features/upload-test/lib/answer-key';
import { calculateObjectiveScore } from '@/lib/score-calculator';
import type { TestPart } from '@/features/upload-test/types';
import type { ObjectiveSkill } from '@/lib/score-calculator';

export const runtime = 'nodejs';

interface UpdateTestPayload {
  testId: string;
  testName: string;
  skill: 'reading' | 'listening';
  metadata: { parts: TestPart[] };
  files: Record<string, string[]>;
  classAssignment: {
    distribution: 'all' | 'specific';
    selectedClasses: string[];
  };
}

async function getIdToken(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

async function canUpdateTest(idToken: string, testId: string): Promise<boolean> {
  const decoded = await getAuth(firebaseAdminApp).verifyIdToken(idToken);
  const email = String(decoded.email || '').trim().toLowerCase();

  if (!email) return false;

  const db = getFirestore(firebaseAdminApp);
  const [userDoc, testDoc] = await Promise.all([
    db.collection('users').doc(email).get(),
    db.collection('tests').doc(testId).get(),
  ]);

  const roleFromToken = String(decoded.role || decoded.userRole || '').trim().toLowerCase();
  const roleFromDoc = String(userDoc.data()?.role || '').trim().toLowerCase();
  const isPrivileged = roleFromToken === 'teacher' || roleFromToken === 'testcreator' || roleFromDoc === 'teacher' || roleFromDoc === 'testcreator';

  if (!isPrivileged) return false;

  // Allow privileged users (teacher/testCreator) to update tests.
  // Legacy tests may have an ownerUid set to a different account; previously
  // the cloud function allowed updates from teachers. To avoid breaking the
  // edit workflow, privileged roles are permitted regardless of ownerUid.
  return true;
}

export async function POST(request: NextRequest) {
  try {
    const token = await getIdToken(request);
    if (!token) {
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    const body = (await request.json()) as UpdateTestPayload;

    if (!body.testId || !body.skill || !body.metadata) {
      return NextResponse.json({ success: false, error: 'Missing required fields.' }, { status: 400 });
    }

    if (body.skill !== 'reading' && body.skill !== 'listening') {
      return NextResponse.json({ success: false, error: 'Only reading and listening tests can be updated via this endpoint.' }, { status: 400 });
    }

    const db = getFirestore(firebaseAdminApp);

    if (!(await canUpdateTest(token, body.testId))) {
      return NextResponse.json({ success: false, error: 'Missing or insufficient permissions.' }, { status: 403 });
    }

    // 1. Regenerate answerKey from existing numbered parts
    // (numbering is already done client-side before sending; no need to recalculate)
    const parts = body.metadata.parts || [];
    const answerKey = generateAnswerKey(parts);

    // 2. Update the test document
    const testRef = db.collection('tests').doc(body.testId);
    await testRef.set({
      name: body.testName || 'Untitled Test',
      skill: body.skill,
      metadata: { parts },
      files: body.files || {},
      answerKey,
      classAssignment: body.classAssignment || { distribution: 'all', selectedClasses: [] },
      updatedAt: new Date(),
    }, { merge: true });

    // 3. Recalculate scores for all existing testResults
    const resultsSnap = await db.collection('testResults').where('testId', '==', body.testId).get();

    let recalculatedCount = 0;

    if (!resultsSnap.empty) {
      const batch = db.batch();

      for (const resultDoc of resultsSnap.docs) {
        const resultData = resultDoc.data();
        const studentAnswers: Record<string, string> = {};

        // Flatten answers: support both nested and flat structures
        if (resultData.answers && typeof resultData.answers === 'object') {
          for (const [k, v] of Object.entries(resultData.answers)) {
            studentAnswers[k] = String(v ?? '').trim();
          }
        }

        const { correctAnswers, totalQuestions, band } = calculateObjectiveScore({
          answers: studentAnswers,
          answerKey,
          parts,
          skill: body.skill as ObjectiveSkill,
        });

        batch.update(resultDoc.ref, {
          correctAnswers,
          totalQuestions,
          ieltsBand: band,
          recalculatedAt: new Date(),
          recalculatedBy: 'updateTest',
        });

        recalculatedCount += 1;

        // Firestore batch limit is 500, flush every 400
        if (recalculatedCount % 400 === 0) {
          await batch.commit();
        }
      }

      // Flush remaining
      await batch.commit();
    }

    return NextResponse.json({
      success: true,
      testId: body.testId,
      recalculatedCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error.';
    console.error('[updateTest API]', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
