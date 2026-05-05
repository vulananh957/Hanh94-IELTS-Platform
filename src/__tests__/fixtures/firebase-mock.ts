/**
 * Shared Firebase mock utilities for unit tests.
 * These mocks intercept calls to 'firebase/firestore' so services
 * never hit the network.
 */

import { vi } from 'vitest';

/** Build a minimal Firestore QueryDocumentSnapshot-like object */
export function makeDoc(id: string, data: Record<string, unknown>) {
  return {
    id,
    data: () => data,
    exists: () => true,
  };
}

/** Build a minimal DocumentSnapshot for getDoc() */
export function makeDocSnap(
  id: string,
  data: Record<string, unknown> | null,
) {
  return {
    id,
    exists: () => data !== null,
    data: () => data ?? undefined,
  };
}

/** Build a minimal QuerySnapshot */
export function makeQuerySnap(docs: ReturnType<typeof makeDoc>[]) {
  return {
    docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach: (cb: (d: ReturnType<typeof makeDoc>) => void) => docs.forEach(cb),
  };
}

/** Create a Firestore Timestamp-like value accepted by the services */
export function makeTimestamp(date: Date) {
  return {
    toDate: () => date,
    seconds: Math.floor(date.getTime() / 1000),
    nanoseconds: 0,
  };
}
