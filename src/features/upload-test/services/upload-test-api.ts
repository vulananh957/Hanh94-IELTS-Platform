'use client';

import { auth } from '@/services/auth';
import type {
  CreateTestPayload,
  ImageRef,
  TestPart,
  TestQuestion,
  TestQuestionType,
  TestSkill,
  UploadFileBucket,
  UploadFileRef,
} from '../types';

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'hanh94esl-71776';
const USE_EMULATOR = process.env.NEXT_PUBLIC_USE_FUNCTIONS_EMULATOR === 'true';
const BASE_URL = USE_EMULATOR
  ? `http://127.0.0.1:5001/${PROJECT_ID}/us-central1`
  : `https://us-central1-${PROJECT_ID}.cloudfunctions.net`;

export interface UploadFileRequest {
  fileName: string;
  fileData: string;
  fileType: string;
  path: string;
}

export interface UploadFileResponse {
  url: string;
}

export interface CheckTestNameResponse {
  success: boolean;
  exists: boolean;
  message?: string;
}

export interface CreateTestResponse {
  testId: string;
}

export interface ClassRecord {
  id: string;
  name?: string;
  code?: string;
  description?: string;
}

export interface GetClassesResponse {
  success: boolean;
  classes: ClassRecord[];
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

export async function getIdToken(): Promise<string> {
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

export async function callCloudFunction<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const token = await getIdToken();

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Cloud Function ${path} failed (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<T>;
}

export function checkTestName(testName: string): Promise<CheckTestNameResponse> {
  return callCloudFunction<CheckTestNameResponse>('/checkTestName', 'POST', { testName });
}

function toJsonSafePayload<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function createTest(payload: CreateTestPayload): Promise<CreateTestResponse> {
  const safePayload = toJsonSafePayload(payload);

  try {
    return await callCloudFunction<CreateTestResponse>('/createTest', 'POST', safePayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Unknown error');

    if (/invalid nested entity/i.test(message)) {
      throw new Error(
        'Submit failed because metadata still contains unsupported nested structure. Please remove empty question groups/questions and submit again.',
      );
    }

    throw error;
  }
}

export function uploadFile(payload: UploadFileRequest): Promise<UploadFileResponse> {
  return callCloudFunction<UploadFileResponse>('/uploadFile', 'POST', payload);
}

export function getClasses(): Promise<GetClassesResponse> {
  return callCloudFunction<GetClassesResponse>('/getClasses', 'POST', {});
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

export function normalizeFileName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function getSafeTestName(testName: string): string {
  const safe = testName
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 50);

  return safe || 'test';
}

function isRemoteLikeImageSrc(value: string): boolean {
  const src = String(value || '').trim();
  return /^https?:\/\//i.test(src) || /^gs:\/\//i.test(src) || src.startsWith('/');
}

function isDataUrl(value: string): boolean {
  return String(value || '').trim().startsWith('data:');
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
    return {
      src,
      name: persistedName,
    };
  }

  if (!isDataUrl(src)) {
    return undefined;
  }

  const uploadedUrl = await uploadFileAndGetURL(input.basePath, fileName, src);
  return {
    src: uploadedUrl,
    name: persistedName,
  };
}

export async function uploadInlineImagesForCreate(input: {
  testName: string;
  parts: TestPart[];
}): Promise<TestPart[]> {
  const safeName = getSafeTestName(input.testName);
  const basePath = `tests/${Date.now()}_${safeName}/metadata-images`;

  const nextParts: TestPart[] = [];

  for (let partIndex = 0; partIndex < (input.parts || []).length; partIndex += 1) {
    const part = input.parts[partIndex];
    const nextQuestionTypes: TestQuestionType[] = [];

    for (let qtIndex = 0; qtIndex < (part.questionTypes || []).length; qtIndex += 1) {
      const questionType = part.questionTypes[qtIndex];
      const nextQuestionType = { ...questionType } as TestQuestionType;

      const questionTypeImage = await uploadInlineImageRef({
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

async function uploadFromRef(basePath: string, fallbackName: string, fileRef: UploadFileRef): Promise<string> {
  const source = fileRef.file || fileRef.dataUrl;

  // If the ref already has a remote URL (e.g. Firebase storage), return it directly
  if (fileRef.url) {
    return fileRef.url;
  }

  // If dataUrl is a remote-like URL (not a data: URI), return it directly too
  if (source && typeof source === 'string' && isRemoteLikeImageSrc(source)) {
    return source;
  }

  if (!source) {
    throw new Error(`File source missing for ${fileRef.name || fallbackName}`);
  }

  return uploadFileAndGetURL(basePath, fileRef.name || fallbackName, source as string);
}

export async function uploadFileAndGetURL(
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

  const response = await uploadFile({
    fileName: normalizeFileName(name),
    fileData,
    fileType,
    path,
  });

  return response.url;
}

export async function uploadDraftFilesForCreate(input: {
  skill: TestSkill;
  testName: string;
  files: UploadFileBucket;
}): Promise<Record<string, string[]>> {
  const safeName = getSafeTestName(input.testName);
  const basePath = `tests/${Date.now()}_${safeName}`;
  const filesOut: Record<string, string[]> = {};

  const readingRef = input.files.reading?.[0] || input.files.sourceDocument?.[0];
  if (input.skill === 'reading') {
    if (!readingRef) {
      throw new Error('Reading test requires a reading PDF to upload.');
    }

    filesOut.reading = [
      await uploadFromRef(`${basePath}/reading`, readingRef.name || 'reading.pdf', readingRef),
    ];
  }

  if (input.skill === 'listening') {
    const listeningKeys: Array<keyof UploadFileBucket> = [
      'listeningPart1',
      'listeningPart2',
      'listeningPart3',
      'listeningPart4',
    ];

    for (const key of listeningKeys) {
      const ref = input.files[key]?.[0];
      if (!ref) {
        throw new Error(`Listening test requires ${String(key)} audio file.`);
      }

      filesOut[String(key)] = [
        await uploadFromRef(`${basePath}/listening/${String(key)}`, ref.name || `${String(key)}.mp3`, ref),
      ];
    }
  }

  if (input.skill === 'writing') {
    const task1 = input.files.writingTask1?.[0];
    const task2 = input.files.writingTask2?.[0];

    if (!task1 || !task2) {
      throw new Error('Writing test requires both Task 1 and Task 2 material images.');
    }

    filesOut.writingTask1 = [
      await uploadFromRef(`${basePath}/writing`, task1.name || 'writing_task1', task1),
    ];
    filesOut.writingTask2 = [
      await uploadFromRef(`${basePath}/writing`, task2.name || 'writing_task2', task2),
    ];
  }

  return filesOut;
}
