// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { generateContentMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(() => ({
    models: {
      generateContent: generateContentMock,
    },
  })),
}));

import { POST } from './route';

function makeExtractionRequest(): NextRequest {
  const formData = new FormData();
  formData.append('skill', 'reading');
  formData.append('pageRange', 'all');
  formData.append('file', new File(['fake-image'], 'test.png', { type: 'image/png' }));

  return new NextRequest('http://localhost/api/extract-test', {
    method: 'POST',
    body: formData,
  });
}

describe('POST /api/extract-test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-api-key';
  });

  it('keeps the 8192 output cap, disables thinking, and generates only once', async () => {
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        parts: [{ name: 'Part 1', questionTypes: [] }],
        warnings: [],
        confidence: [],
      }),
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 40,
        thoughtsTokenCount: 0,
        totalTokenCount: 140,
      },
    });

    const response = await POST(makeExtractionRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(generateContentMock).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 },
        httpOptions: expect.objectContaining({ timeout: 45_000 }),
      }),
    }));
  });

  it('does not regenerate with a larger token budget after MAX_TOKENS', async () => {
    generateContentMock.mockResolvedValue({
      text: '{"parts": [',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: {
        candidatesTokenCount: 8192,
        thoughtsTokenCount: 0,
      },
    });

    const response = await POST(makeExtractionRequest());
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.ok).toBe(false);
    expect(payload.details).toContain('fixed 8192-token limit');
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });
});
