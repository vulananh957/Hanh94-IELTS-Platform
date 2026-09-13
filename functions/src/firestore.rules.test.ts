// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const projectId = 'hanh94esl-test-access-rules';
const repositoryRoot = process.cwd().endsWith('/functions') ? resolve(process.cwd(), '..') : process.cwd();
let testEnv: RulesTestEnvironment;
const describeWithEmulator = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

describeWithEmulator('student test access rules', () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId,
      firestore: {
        rules: readFileSync(resolve(repositoryRoot, 'firebase/firestore.rules'), 'utf8'),
      },
    });
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await Promise.all([
        setDoc(doc(db, 'users', 'student@example.com'), {
          email: 'student@example.com', role: 'student', classId: 'class-a', classCode: 'A',
        }),
        setDoc(doc(db, 'tests', 'test-a'), {
          name: 'Assigned Test', answerKey: { 1: 'secret' },
          classAssignment: { distribution: 'specific', selectedClasses: ['class-a'] },
        }),
        setDoc(doc(db, 'tests', 'test-b'), {
          name: 'Other Test', answerKey: { 1: 'secret' },
          classAssignment: { distribution: 'specific', selectedClasses: ['class-b'] },
        }),
        setDoc(doc(db, 'tests', 'test-c'), {
          name: 'Legacy restricted Test', answerKey: { 1: 'secret' },
          classAssignment: { selectedClasses: ['class-b'] },
        }),
        setDoc(doc(db, 'tests', 'test-d'), {
          name: 'Mixed restricted Test', answerKey: { 1: 'secret' },
          classAssignment: { distribution: 'all', selectedClasses: ['class-b'] },
        }),
      ]);
    });
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });
  it('denies every student direct Test document read and collection scan', async () => {
    const db = testEnv.authenticatedContext('student-1', {
      email: 'student@example.com', role: 'student',
    }).firestore();

    await assertFails(getDoc(doc(db, 'tests', 'test-a')));
    await assertFails(getDoc(doc(db, 'tests', 'test-b')));
    await assertFails(getDoc(doc(db, 'tests', 'test-c')));
    await assertFails(getDoc(doc(db, 'tests', 'test-d')));
    await assertFails(getDocs(collection(db, 'tests')));
  });

  it('blocks direct test reads, attempt creation, autosave, and submit while locked', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'testAccessLocks', 'test-a--student-1'), {
        testId: 'test-a', studentUid: 'student-1', status: 'locked',
      });
    });
    const db = testEnv.authenticatedContext('student-1', {
      email: 'student@example.com', role: 'student',
    }).firestore();

    await assertFails(getDoc(doc(db, 'tests', 'test-a')));
    await assertFails(setDoc(doc(db, 'attempts', 'attempt-1'), {
      testId: 'test-a', studentUid: 'student-1', status: 'in_progress',
    }));
    await assertFails(setDoc(doc(db, 'testResults', 'attempt-1'), {
      testId: 'test-a', studentEmail: 'student@example.com', status: 'completed',
    }));
    await assertFails(setDoc(doc(db, 'writing', 'attempt-1'), {
      testId: 'test-a', studentUid: 'student-1', status: 'pending',
    }));
    await assertFails(setDoc(doc(db, 'testAccessLocks', 'test-a--student-1'), {
      status: 'unlocked', studentUid: 'student-1', testId: 'test-a',
    }, { merge: true }));
  });

  it('lets teachers inspect tests and locks while keeping lock writes backend-only', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'testAccessLocks', 'test-a--student-1'), {
        testId: 'test-a', studentUid: 'student-1', status: 'locked',
      });
    });
    const db = testEnv.authenticatedContext('teacher-1', {
      email: 'teacher@example.com', role: 'teacher',
    }).firestore();

    await assertSucceeds(getDocs(collection(db, 'tests')));
    await assertSucceeds(getDoc(doc(db, 'testAccessLocks', 'test-a--student-1')));
    await assertFails(setDoc(doc(db, 'testAccessLocks', 'test-a--student-1'), { status: 'unlocked' }, { merge: true }));
  });
});
