import type { TestPart } from '@/features/upload-test/types';
import { calculateIELTSBand } from '@/app/(dashboard)/student/take-test/take-test-utils';

export type ObjectiveSkill = 'reading' | 'listening';

/* ── helpers ─────────────────────────────────────────────────────── */

function asRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function toPositiveInt(value: unknown, fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return next > 0 ? Math.floor(next) : fallback;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function splitAnswerTokens(value: string): string[] {
  return value
    .split(/[\s,;/]+/)
    .map((choice) => choice.trim().toUpperCase())
    .filter(Boolean);
}

function isChooseMultipleType(type: string): boolean {
  return /multiple choice.*choose multiple/i.test(type);
}

function matchAnswer(student: string, correct: string): boolean {
  if (!student || !correct) return false;
  const s = normalize(student);
  if (!s) return false;

  const keyLetter = student.match(/^[A-Z](?:\.|\s)/)?.[0]?.toUpperCase()
    ?? correct.match(/^[A-Z](?:\.|\s)/)?.[0]?.toUpperCase();
  const stuLetter = student.match(/^[A-Z](?:\.|\s)/)?.[0]?.toUpperCase();

  if (keyLetter && stuLetter) {
    return keyLetter === stuLetter;
  }

  const acceptedAnswers = correct
    .split('/')
    .map((token) => normalize(token.trim()))
    .filter(Boolean);

  if (acceptedAnswers.some((c) => s === c)) return true;

  // Token-based comparison: split on spaces/commas/semicolons and compare as sets
  const studentTokens = splitAnswerTokens(student);
  const correctTokens = splitAnswerTokens(correct);
  if (
    studentTokens.length > 0 &&
    studentTokens.length === correctTokens.length &&
    studentTokens.every((tok) => correctTokens.includes(tok))
  ) {
    return true;
  }

  return false;
}

function flattenAnswerKey(ak: unknown): Record<string, string> {
  const raw = asRecord(ak);
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      // Join with '/' so matchAnswer's slash-splitting can parse each alternative
      flat[k] = v.map((x) => String(x ?? '').trim()).filter(Boolean).join('/');
    } else {
      flat[k] = String(v ?? '').trim();
    }
  }
  return flat;
}

function flattenStudentAnswers(ans: unknown): Record<string, string> {
  const raw = asRecord(ans);
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    flat[k] = String(v ?? '').trim();
  }
  return flat;
}

/* ── core scoring ─────────────────────────────────────────────────── */

function computeScoreForParts(
  parts: TestPart[],
  studentAnswers: Record<string, string>,
): { correctAnswers: number; totalQuestions: number } {
  let totalCorrect = 0;
  let totalQuestions = 0;

  for (const part of parts) {
    const questionTypes = part.questionTypes || [];
    for (const qt of questionTypes) {
      if (isChooseMultipleType(qt.type)) {
        for (const question of qt.questions || []) {
          const rec = question as Record<string, unknown>;
          const choiceCount = toPositiveInt(rec.choiceCount, 2);
          const startNumber = toPositiveInt(qt.startNumber, 1);

          // Each sub-item within the group counts as 1 question
          for (let subIdx = 0; subIdx < choiceCount; subIdx += 1) {
            const subNum = startNumber + subIdx;
            const correctToken = String(
              (rec.correctAnswers as string[])?.[subIdx] ?? '',
            ).trim().toUpperCase();

            if (!correctToken) {
              totalQuestions += 1;
              continue;
            }

            const groupKey = `${startNumber}-${startNumber + choiceCount - 1}`;
            const groupAnswer = studentAnswers[groupKey] || studentAnswers[String(subNum)] || '';
            const studentTokens = Array.from(new Set(splitAnswerTokens(groupAnswer)));
            const isCorrect = studentTokens.some((t) => matchAnswer(t, correctToken));

            totalCorrect += isCorrect ? 1 : 0;
            totalQuestions += 1;
          }
        }
      } else {
        for (const question of qt.questions || []) {
          const rec = question as Record<string, unknown>;
          const correct = String(rec.correctAnswer ?? '').trim();
          const qNum = String(toPositiveInt(qt.startNumber, 1) + ((qt.questions || []).indexOf(question)));
          const student = studentAnswers[qNum] || '';

          if (!correct) {
            totalQuestions += 1;
            continue;
          }

          totalCorrect += matchAnswer(student, correct) ? 1 : 0;
          totalQuestions += 1;
        }
      }
    }
  }

  return { correctAnswers: totalCorrect, totalQuestions };
}

/* ── public API ──────────────────────────────────────────────────── */

export interface ScoreCalculationResult {
  correctAnswers: number;
  totalQuestions: number;
  band: number;
}

/**
 * Compute the objective score for a student's test submission,
 * given the full parts structure and their raw answers map.
 *
 * Used by:
 *   - ObjectiveTestDrawer (replaces inlined logic)
 *   - updateTest Cloud Function (batch recalculation)
 */
export function calculateObjectiveScore(params: {
  answers: Record<string, string>;
  answerKey: Record<string, string | string[]>;
  parts: TestPart[];
  skill: ObjectiveSkill;
}): ScoreCalculationResult {
  // Flatten student answers if passed as a nested object
  const studentAnswers = flattenStudentAnswers(params.answers);

  // Compute raw correct / total
  const { correctAnswers, totalQuestions } = computeScoreForParts(params.parts, studentAnswers);

  // Compute IELTS band
  const band = calculateIELTSBand(correctAnswers, params.skill);

  return { correctAnswers, totalQuestions, band };
}
