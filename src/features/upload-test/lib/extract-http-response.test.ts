import { describe, expect, it } from 'vitest';
import { parseExtractHttpResponse } from './extract-http-response';

describe('parseExtractHttpResponse', () => {
  it('parses a successful JSON payload', async () => {
    const response = new Response(JSON.stringify({
      ok: true,
      data: { parts: [], warnings: [], confidence: [] },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await expect(parseExtractHttpResponse(response)).resolves.toMatchObject({ ok: true });
  });

  it('preserves a structured API error payload', async () => {
    const response = new Response(JSON.stringify({
      ok: false,
      error: 'Failed to extract test data.',
      details: 'Upstream error',
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });

    await expect(parseExtractHttpResponse(response)).resolves.toEqual({
      ok: false,
      error: 'Failed to extract test data.',
      details: 'Upstream error',
    });
  });

  it('turns a Firebase 504 HTML page into a useful timeout error', async () => {
    const response = new Response('<!DOCTYPE html><html><title>Gateway Timeout</title></html>', {
      status: 504,
      statusText: 'Gateway Timeout',
      headers: { 'content-type': 'text/html' },
    });

    await expect(parseExtractHttpResponse(response)).rejects.toThrow(
      'Extraction timed out at the hosting gateway (60 seconds)',
    );
  });

  it('reports non-JSON HTTP responses without exposing the raw HTML body', async () => {
    const response = new Response('<!DOCTYPE html><html><title>Service Unavailable</title></html>', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'content-type': 'text/html' },
    });

    await expect(parseExtractHttpResponse(response)).rejects.toThrow(
      'Extraction API returned HTTP 503 Service Unavailable instead of JSON (Service Unavailable).',
    );
  });
});
