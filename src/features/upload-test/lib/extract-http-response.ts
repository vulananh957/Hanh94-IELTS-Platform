import type { ExtractTestErrorResponse, ExtractTestResponse } from '../types';

type ExtractApiPayload = ExtractTestResponse | ExtractTestErrorResponse;

function isExtractApiPayload(value: unknown): value is ExtractApiPayload {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as { ok?: unknown }).ok === 'boolean';
}

function getHtmlTitle(body: string): string {
  const match = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return String(match?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function buildNonJsonError(response: Response, body: string): string {
  if (response.status === 504) {
    return 'Extraction timed out at the hosting gateway (60 seconds) before a valid response was returned.';
  }

  const title = getHtmlTitle(body);
  const statusLabel = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  return `Extraction API returned HTTP ${statusLabel} instead of JSON${title ? ` (${title})` : ''}.`;
}

export async function parseExtractHttpResponse(response: Response): Promise<ExtractApiPayload> {
  const body = await response.text();
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(buildNonJsonError(response, body));
  }

  if (!isExtractApiPayload(parsed)) {
    throw new Error('Extraction API returned an invalid JSON response.');
  }

  return parsed;
}
