import { GoogleGenAI } from '@google/genai';
import * as mammoth from 'mammoth';
import { NextRequest, NextResponse } from 'next/server';
import {
  ExtractRequestSchema,
  NormalizedExtractedPayloadSchema,
  RawExtractedPayloadSchema,
} from '@/features/upload-test/schema';
import { normalizeExtractedPayload } from '@/features/upload-test/lib/normalize';
import { formatPageRange, parsePageRange } from '@/features/upload-test/lib/page-range';
import { buildExtractionSystemPrompt, extractionResponseJsonSchema } from '@/features/upload-test/lib/prompt';

export const runtime = 'nodejs';

const PINNED_GEMINI_MODEL = 'gemini-2.5-flash' as const;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_GEMINI_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 700;
const MAX_RETRY_DELAY_MS = 5000;
const PRIMARY_MAX_OUTPUT_TOKENS = 8192;
// Firebase Hosting terminates dynamic requests at 60 seconds. Leave enough
// time for this route to turn an upstream timeout into a JSON response.
const GEMINI_REQUEST_TIMEOUT_MS = 45_000;
const EXTRACTION_DEADLINE_MS = 52_000;
const MIN_RETRY_WINDOW_MS = 8_000;
const MAX_WORD_TEXT_CHARS = 120_000;

const DOC_MIME_TYPE = 'application/msword';
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function detectStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    const text = toErrorMessage(error);
    const parsed = text.match(/\b(429|500|502|503|504)\b/);
    return parsed ? Number(parsed[1]) : null;
  }

  const record = error as {
    status?: unknown;
    code?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };

  const candidates = [record.statusCode, record.code, record.status, record.response?.status];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  const text = toErrorMessage(error);
  const parsed = text.match(/\b(429|500|502|503|504)\b/);
  return parsed ? Number(parsed[1]) : null;
}

function isRetryableGeminiError(error: unknown): boolean {
  const statusCode = detectStatusCode(error);
  if (statusCode && [429, 500, 502, 503, 504].includes(statusCode)) {
    return true;
  }

  const text = toErrorMessage(error).toLowerCase();
  return (
    text.includes('unavailable')
    || text.includes('high demand')
    || text.includes('resource exhausted')
    || text.includes('rate limit')
    || text.includes('too many requests')
    || text.includes('temporarily')
    || text.includes('timeout')
    || text.includes('overloaded')
  );
}

function computeBackoffDelay(attempt: number): number {
  const exponential = BASE_RETRY_DELAY_MS * (2 ** attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(exponential + jitter, MAX_RETRY_DELAY_MS);
}

function isSupportedMimeType(mimeType: string): boolean {
  return (
    mimeType === 'application/pdf'
    || mimeType.startsWith('image/')
    || mimeType === DOC_MIME_TYPE
    || mimeType === DOCX_MIME_TYPE
  );
}

function isWordMimeType(mimeType: string): boolean {
  return mimeType === DOC_MIME_TYPE || mimeType === DOCX_MIME_TYPE;
}

function inferMimeTypeFromName(fileName: string): string {
  const name = fileName.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.docx')) return DOCX_MIME_TYPE;
  if (name.endsWith('.doc')) return DOC_MIME_TYPE;
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

async function extractDocxText(fileBytes: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: fileBytes });
  const text = String(result.value || '').trim();
  if (!text) {
    throw new Error('DOCX file does not contain extractable text.');
  }

  if (text.length <= MAX_WORD_TEXT_CHARS) {
    return text;
  }

  return text.slice(0, MAX_WORD_TEXT_CHARS);
}

function getFirstCandidateFinishReason(response: unknown): string {
  if (!response || typeof response !== 'object') {
    return '';
  }

  const record = response as {
    candidates?: Array<{ finishReason?: unknown }>;
  };

  return String(record.candidates?.[0]?.finishReason || '').trim().toUpperCase();
}

function isLikelyTokenLimitFinishReason(reason: string): boolean {
  if (!reason) return false;

  return (
    reason.includes('MAX_TOKENS')
    || reason.includes('TOKEN')
    || reason.includes('LENGTH')
  );
}

function logGeminiUsage(response: unknown, finishReason: string): void {
  if (!response || typeof response !== 'object') return;

  const usage = (response as {
    usageMetadata?: {
      promptTokenCount?: unknown;
      candidatesTokenCount?: unknown;
      thoughtsTokenCount?: unknown;
      totalTokenCount?: unknown;
    };
  }).usageMetadata;

  console.info('[extract-test] Gemini generation completed.', {
    finishReason: finishReason || 'UNKNOWN',
    promptTokens: usage?.promptTokenCount,
    outputTokens: usage?.candidatesTokenCount,
    thinkingTokens: usage?.thoughtsTokenCount,
    totalTokens: usage?.totalTokenCount,
  });
}

function tryParseJsonCandidate(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function collectCodeFenceCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)\s*```/gi;

  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text)) !== null) {
    const content = String(match[1] || '').trim();
    if (content) {
      candidates.push(content);
    }
  }

  return candidates;
}

function collectBalancedCandidates(text: string, opening: '{' | '[', closing: '}' | ']'): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === opening) {
      if (depth === 0) {
        startIndex = index;
      }

      depth += 1;
      continue;
    }

    if (char === closing && depth > 0) {
      depth -= 1;

      if (depth === 0 && startIndex >= 0) {
        candidates.push(text.slice(startIndex, index + 1));
        startIndex = -1;
      }
    }
  }

  return candidates;
}

function safeParseModelJson(rawText: string): unknown {
  const trimmed = rawText.trim().replace(/^\uFEFF/, '');

  if (!trimmed) {
    throw new Error('Model returned an empty response.');
  }

  const candidates: string[] = [trimmed];

  if (/^json\b/i.test(trimmed)) {
    candidates.push(trimmed.replace(/^json\b\s*/i, '').trim());
  }

  candidates.push(...collectCodeFenceCandidates(trimmed));
  candidates.push(...collectBalancedCandidates(trimmed, '{', '}'));
  candidates.push(...collectBalancedCandidates(trimmed, '[', ']'));

  const dedupedCandidates = Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)));

  for (const candidate of dedupedCandidates) {
    const parsed = tryParseJsonCandidate(candidate);
    if (parsed != null) {
      return parsed;
    }
  }

  const snippet = trimmed.replace(/\s+/g, ' ').slice(0, 280);
  throw new Error(`Model response is not valid JSON. Raw snippet: ${snippet}`);
}

export async function POST(request: NextRequest) {
  const extractionStartedAt = Date.now();
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Missing Gemini API key. Configure GEMINI_API_KEY in environment.',
      },
      { status: 500 },
    );
  }

  try {
    const formData = await request.formData();

    const rawSkill = formData.get('skill');
    const rawPageRange = formData.get('pageRange');
    const rawFile = formData.get('file');

    const inputResult = ExtractRequestSchema.safeParse({
      skill: typeof rawSkill === 'string' ? rawSkill : '',
      pageRange: typeof rawPageRange === 'string' ? rawPageRange : '',
    });

    if (!inputResult.success) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Invalid extraction request.',
          issues: inputResult.error.issues.map((issue) => issue.message),
        },
        { status: 400 },
      );
    }

    if (!(rawFile instanceof File)) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Missing file in extraction request.',
        },
        { status: 400 },
      );
    }

    if (rawFile.size <= 0) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Uploaded file is empty.',
        },
        { status: 400 },
      );
    }

    if (rawFile.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          error: `File exceeds size limit (${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB).`,
        },
        { status: 413 },
      );
    }

    const mimeType = rawFile.type || inferMimeTypeFromName(rawFile.name);
    if (!isSupportedMimeType(mimeType)) {
      return NextResponse.json(
        {
          ok: false,
          error: `Unsupported file type: ${mimeType}. Only PDF, DOC/DOCX, and images are allowed.`,
        },
        { status: 415 },
      );
    }

    if (mimeType === DOC_MIME_TYPE) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Legacy .doc is currently not supported for extraction. Please convert to .docx or PDF.',
        },
        { status: 415 },
      );
    }

    let normalizedPageRange = inputResult.data.pageRange;
    try {
      const parsedRange = parsePageRange(inputResult.data.pageRange);
      normalizedPageRange = formatPageRange(parsedRange);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid page range.';

      return NextResponse.json(
        {
          ok: false,
          error: message,
        },
        { status: 400 },
      );
    }

    const fileBytes = Buffer.from(await rawFile.arrayBuffer());
    const fileBase64 = fileBytes.toString('base64');

    const systemPrompt = buildExtractionSystemPrompt({
      skill: inputResult.data.skill,
      pageRange: normalizedPageRange,
      fileName: rawFile.name,
    });

    const ai = new GoogleGenAI({ apiKey });
    const modelContents: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: systemPrompt },
    ];

    if (isWordMimeType(mimeType)) {
      const extractedWordText = await extractDocxText(fileBytes);
      modelContents.push({
        text: `Word document content (plain text):\n${extractedWordText}`,
      });
    } else {
      modelContents.push({
        inlineData: {
          mimeType,
          data: fileBase64,
        },
      });
    }

    const generateWithRetry = async () => {
      let modelResponse: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
      let lastGeminiError: unknown = null;

      for (let attempt = 0; attempt <= MAX_GEMINI_RETRIES; attempt += 1) {
        const remainingMs = EXTRACTION_DEADLINE_MS - (Date.now() - extractionStartedAt);
        if (remainingMs < MIN_RETRY_WINDOW_MS) {
          throw lastGeminiError || new Error('Gemini request exceeded the extraction time budget.');
        }

        try {
          modelResponse = await ai.models.generateContent({
            model: PINNED_GEMINI_MODEL,
            contents: modelContents as any,
            config: {
              temperature: 0.1,
              // Keep the existing output cap. Thinking is disabled because this
              // task is structured transcription, and Gemini 2.5 Flash otherwise
              // spends paid output budget and latency on dynamic thinking.
              maxOutputTokens: PRIMARY_MAX_OUTPUT_TOKENS,
              thinkingConfig: {
                thinkingBudget: 0,
              },
              httpOptions: {
                timeout: Math.min(GEMINI_REQUEST_TIMEOUT_MS, remainingMs - 2_000),
              },
              responseMimeType: 'application/json',
              responseJsonSchema: extractionResponseJsonSchema,
            },
          });

          break;
        } catch (error) {
          lastGeminiError = error;

          if (!isRetryableGeminiError(error) || attempt >= MAX_GEMINI_RETRIES) {
            throw error;
          }

          const delay = computeBackoffDelay(attempt);
          const remainingAfterDelay = EXTRACTION_DEADLINE_MS - (Date.now() - extractionStartedAt) - delay;
          if (remainingAfterDelay < MIN_RETRY_WINDOW_MS) {
            throw error;
          }

          console.warn(
            `[extract-test] Gemini transient error on attempt ${attempt + 1}/${MAX_GEMINI_RETRIES + 1}. Retrying in ${delay}ms.`,
            toErrorMessage(error),
          );
          await sleep(delay);
        }
      }

      if (!modelResponse) {
        throw lastGeminiError || new Error('Gemini did not return a response.');
      }

      return modelResponse;
    };

    const modelResponse = await generateWithRetry();
    const finishReason = getFirstCandidateFinishReason(modelResponse);
    logGeminiUsage(modelResponse, finishReason);

    const modelText = typeof modelResponse.text === 'string' ? modelResponse.text : '';
    let rawJson: unknown;

    try {
      rawJson = safeParseModelJson(modelText);
    } catch (parseError) {
      if (isLikelyTokenLimitFinishReason(finishReason)) {
        throw new Error(
          `Gemini output reached the fixed ${PRIMARY_MAX_OUTPUT_TOKENS}-token limit. `
          + 'The request was not regenerated with a larger budget to avoid extra cost.',
        );
      }

      throw parseError;
    }

    const rawPayloadResult = RawExtractedPayloadSchema.safeParse(rawJson);
    if (!rawPayloadResult.success) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Gemini response validation failed (raw payload).',
          issues: rawPayloadResult.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
        { status: 422 },
      );
    }

    const normalizedPayload = normalizeExtractedPayload({
      skill: inputResult.data.skill,
      payload: rawPayloadResult.data,
    });

    const normalizedResult = NormalizedExtractedPayloadSchema.safeParse(normalizedPayload);
    if (!normalizedResult.success) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Normalized payload validation failed.',
          issues: normalizedResult.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
        { status: 422 },
      );
    }

    return NextResponse.json({
      ok: true,
      data: normalizedResult.data,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown extraction error.';
    const retryable = isRetryableGeminiError(error);

    return NextResponse.json(
      {
        ok: false,
        error: retryable
          ? 'Gemini service is temporarily overloaded. Please retry in 30-60 seconds.'
          : 'Failed to extract test data.',
        details: retryable
          ? `${message} (auto-retry exhausted after ${MAX_GEMINI_RETRIES + 1} attempts)`
          : message,
      },
      { status: retryable ? 503 : 500 },
    );
  }
}
