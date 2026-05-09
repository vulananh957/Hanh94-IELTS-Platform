import { NextRequest, NextResponse } from 'next/server';
import { getFirestore, doc, getDocs, query, where, updateDoc, writeBatch, collection } from 'firebase/firestore';
import { firebaseApp } from '@/services/firebase';
import { generateAnswerKey } from '@/features/upload-test/lib/answer-key';
import { calculateQuestionNumbers } from '@/features/upload-test/lib/numbering';
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

    const db = getFirestore(firebaseApp);

    // 1. Normalize parts and regenerate answerKey
    const numberedParts = calculateQuestionNumbers(body.metadata.parts || []);
    const answerKey = generateAnswerKey(numberedParts);

    // 2. Update the test document
    const testRef = doc(db, 'tests', body.testId);
    await updateDoc(testRef, {
      name: body.testName || 'Untitled Test',
      skill: body.skill,
      metadata: { parts: numberedParts },
      files: body.files || {},
      answerKey,
      classAssignment: body.classAssignment || { distribution: 'all', selectedClasses: [] },
      updatedAt: new Date(),
    });

    // 3. Recalculate scores for all existing testResults
    const resultsQuery = query(
      collection(db, 'testResults'),
      where('testId', '==', body.testId),
    );
    const resultsSnap = await getDocs(resultsQuery);

    let recalculatedCount = 0;

    if (!resultsSnap.empty) {
      const batch = writeBatch(db);

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
          parts: numberedParts,
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
