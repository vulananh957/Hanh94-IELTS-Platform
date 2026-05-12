'use client';

import { auth } from '@/services/auth';
import {
  fileToDataUrl,
  uploadFile,
  getIdToken,
  callCloudFunction,
  normalizeFileName,
} from './upload-test-api';
import type {
  ImageRef,
  TestPart,
  TestQuestion,
  TestQuestionType,
  TestSkill,
} from '../types';

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'hanh94esl-71776';
const USE_EMULATOR = process.env.NEXT_PUBLIC_USE_FUNCTIONS_EMULATOR === 'true';
const BASE_URL = USE_EMULATOR
  ? `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`
  : `https://us-central1-${PROJECT_ID}.cloudfunctions.net`;

export interface UpdateTestRequest {
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

export interface UpdateTestResponse {
  success: boolean;
  testId: string;
  recalculatedCount: number;
  error?: string;
}

async function uploadFileAndGetURL(
  basePath: string,
  name: string,
  fileOrDataUrl: File | string,
): Promise<string> {
  const path = `${basePath}/${normalizeFileName(name)}`;
  let fileData = '';
  let fileType = 'application/octet-stream';

  if (typeof fileOrDataUrl === 'string' && fileOrDataUrl.startsWith('data:')) {
    fileData = fileOrDataUrl;
    fileType = fileOrDataUrl.split(';')[0]?.split(':')[1] || fileType;
  } else if (fileOrDataUrl instanceof File) {
    fileData = await fileToDataUrl(fileOrDataUrl);
    fileType = fileOrDataUrl.type || fileType;
  } else {
    throw new Error('Unsupported upload source.');
  }

  const response = await uploadFile({ fileName: normalizeFileName(name), fileData, fileType, path });
  return response.url;
}

function isRemoteLikeImageSrc(value: string): boolean {
  const src = String(value || '').trim();
  return /^https?:\/\//i.test(src) || /^gs:\/\//i.test(src) || src.startsWith('/');
}

function inferImageExtension(imageName: string, imageSrc: string): string {
  const normalizedName = String(imageName || '').trim().toLowerCase();
  if (normalizedName.endsWith('.png')) return 'png';
  if (normalizedName.endsWith('.jpg') || normalizedName.endsWith('.jpeg')) return 'jpg';
  if (normalizedName.endsWith('.webp')) return 'webp';
  if (normalizedName.endsWith('.gif')) return 'gif';

  const mimeType = String(imageSrc || '').split(';')[0]?.split(':')[1] || '';
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';

  return 'png';
}

function ensureImageFileName(name: string, src: string, fallbackStem: string): string {
  const trimmed = String(name || '').trim();
  const normalized = normalizeFileName(trimmed || fallbackStem);
  if (/\.[a-z0-9]+$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}.${inferImageExtension(normalized, src)}`;
}

async function uploadInlineImageRef(input: {
  testId: string;
  basePath: string;
  fallbackStem: string;
  imageData?: ImageRef;
}): Promise<ImageRef | undefined> {
  const imageData = input.imageData;
  if (!imageData?.src) return undefined;

  const src = String(imageData.src || '').trim();
  if (!src) return undefined;

  const fileName = ensureImageFileName(imageData.name || '', src, input.fallbackStem);
  const persistedName = String(imageData.name || '').trim() || fileName;

  if (isRemoteLikeImageSrc(src)) {
    return { src, name: persistedName };
  }

  if (!src.startsWith('data:')) {
    return undefined;
  }

  const uploadedUrl = await uploadFileAndGetURL(input.basePath, fileName, src);
  return { src: uploadedUrl, name: persistedName };
}

/**
 * Upload inline images for questions that have new data URLs (newly dropped images).
 * Existing remote URLs are preserved as-is.
 * Uses the existing test's storage path prefix.
 */
export async function uploadInlineImagesForEdit(input: {
  testId: string;
  testName: string;
  parts: TestPart[];
}): Promise<TestPart[]> {
  const basePath = `tests/${input.testId}/metadata-images`;

  const nextParts: TestPart[] = [];

  for (let partIndex = 0; partIndex < (input.parts || []).length; partIndex += 1) {
    const part = input.parts[partIndex];
    const nextQuestionTypes: TestQuestionType[] = [];

    for (let qtIndex = 0; qtIndex < (part.questionTypes || []).length; qtIndex += 1) {
      const questionType = part.questionTypes[qtIndex];
      const nextQuestionType = { ...questionType } as TestQuestionType;

      const questionTypeImage = await uploadInlineImageRef({
        testId: input.testId,
        basePath: `${basePath}/part${partIndex + 1}/qt${qtIndex + 1}`,
        fallbackStem: `part_${partIndex + 1}_qt_${qtIndex + 1}`,
        imageData: questionType.imageData,
      });

      if (questionTypeImage) {
        nextQuestionType.imageData = questionTypeImage;
      } else {
        delete (nextQuestionType as { imageData?: unknown }).imageData;
      }

      const nextQuestions: TestQuestion[] = [];

      for (let questionIndex = 0; questionIndex < (questionType.questions || []).length; questionIndex += 1) {
        const question = questionType.questions[questionIndex] || {};
        const nextQuestion = { ...question } as TestQuestion;

        const questionImage = await uploadInlineImageRef({
          testId: input.testId,
          basePath: `${basePath}/part${partIndex + 1}/qt${qtIndex + 1}/questions`,
          fallbackStem: `part_${partIndex + 1}_qt_${qtIndex + 1}_q_${questionIndex + 1}`,
          imageData: (question as { imageData?: ImageRef }).imageData,
        });

        if (questionImage) {
          (nextQuestion as { imageData?: ImageRef }).imageData = questionImage;
        } else {
          delete (nextQuestion as { imageData?: unknown }).imageData;
        }

        nextQuestions.push(nextQuestion);
      }

      nextQuestionType.questions = nextQuestions;
      nextQuestionTypes.push(nextQuestionType);
    }

    nextParts.push({
      ...part,
      questionTypes: nextQuestionTypes,
    });
  }

  return nextParts;
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

async function getIdTokenLocal(): Promise<string> {
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

async function callUpdateTestApi<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const token = await getIdTokenLocal();
  const response = await fetch('/api/update-test', {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`updateTest API failed (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<T>;
}

export async function updateTest(payload: UpdateTestRequest): Promise<UpdateTestResponse> {
  const safePayload = JSON.parse(JSON.stringify(payload));
  return callUpdateTestApi<UpdateTestResponse>('/updateTest', 'POST', safePayload);
}
