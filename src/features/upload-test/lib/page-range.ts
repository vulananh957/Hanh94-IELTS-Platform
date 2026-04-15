import { PAGE_RANGE_PATTERN } from '../schema';

export interface PageSegment {
  start: number;
  end: number;
}

export interface ParsedPageRangeAll {
  mode: 'all';
}

export interface ParsedPageRangeCustom {
  mode: 'custom';
  segments: PageSegment[];
}

export type ParsedPageRange = ParsedPageRangeAll | ParsedPageRangeCustom;

function toInt(value: string): number {
  const next = Number(value);
  if (!Number.isInteger(next) || next <= 0) {
    throw new Error(`Invalid page number: ${value}`);
  }

  return next;
}

export function parsePageRange(input: string): ParsedPageRange {
  const value = input.trim();

  if (!PAGE_RANGE_PATTERN.test(value)) {
    throw new Error('Invalid page range format.');
  }

  if (value.toLowerCase() === 'all') {
    return { mode: 'all' };
  }

  const segments = value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      if (!token.includes('-')) {
        const page = toInt(token);
        return { start: page, end: page };
      }

      const [startRaw, endRaw] = token.split('-').map((item) => item.trim());
      const start = toInt(startRaw);
      const end = toInt(endRaw);

      if (start > end) {
        throw new Error(`Invalid range ${token}: start cannot be greater than end.`);
      }

      return { start, end };
    })
    .sort((left, right) => left.start - right.start);

  const merged: PageSegment[] = [];

  segments.forEach((segment) => {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(segment);
      return;
    }

    if (segment.start <= last.end + 1) {
      last.end = Math.max(last.end, segment.end);
      return;
    }

    merged.push(segment);
  });

  return {
    mode: 'custom',
    segments: merged,
  };
}

export function formatPageRange(parsed: ParsedPageRange): string {
  if (parsed.mode === 'all') {
    return 'all';
  }

  return parsed.segments
    .map((segment) => {
      if (segment.start === segment.end) {
        return String(segment.start);
      }

      return `${segment.start}-${segment.end}`;
    })
    .join(',');
}
