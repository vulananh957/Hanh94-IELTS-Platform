'use client';

import { getStorage, getDownloadURL, ref } from 'firebase/storage';
import { firebaseApp } from './firebase';

/**
 * Extract object path from Firebase Storage HTTP URL
 * Supports multiple URL formats:
 * - https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encodedPath>
 * - https://storage.googleapis.com/<bucket>/<objectPath>
 */
function extractStoragePathFromHttpUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname;

    // firebasestorage.googleapis.com format: /v0/b/<bucket>/o/<encodedPath>
    const firebaseMatch = path.match(/\/o\/([^/]+)$/);
    if (firebaseMatch?.[1]) {
      return decodeURIComponent(firebaseMatch[1]);
    }

    // storage.googleapis.com format: /<bucket>/<objectPath>
    if (url.hostname === 'storage.googleapis.com') {
      const parts = path.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return decodeURIComponent(parts.slice(1).join('/'));
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Resolve a single material URL to an authenticated download URL.
 * Handles gs:// URLs, Storage HTTP URLs, and raw object paths.
 * Falls back gracefully if resolution fails.
 */
export async function resolveMaterialUrl(rawValue: string): Promise<string> {
  const value = rawValue.trim();
  if (!value) return '';

  const storage = getStorage(firebaseApp);

  // Handle gs:// Cloud Storage reference
  if (value.startsWith('gs://')) {
    try {
      return await getDownloadURL(ref(storage, value));
    } catch (err) {
      console.warn('[MATERIAL] Failed to resolve gs:// URL:', value, err);
      return value; // Return original if resolution fails
    }
  }

  // Handle HTTP(S) URLs (may be Firebase Storage or external)
  if (value.startsWith('http://') || value.startsWith('https://')) {
    // Check if it's a Firebase Storage URL
    const storagePath = extractStoragePathFromHttpUrl(value);
    if (storagePath) {
      try {
        return await getDownloadURL(ref(storage, storagePath));
      } catch (err) {
        console.warn('[MATERIAL] Failed to resolve storage HTTP URL:', value, err);
        return value; // Return original if resolution fails
      }
    }
    // External URL, return as-is
    return value;
  }

  // Handle raw object paths (with or without leading slash)
  if (value.includes('/')) {
    const normalizedPath = value.replace(/^\/+/, '');
    try {
      return await getDownloadURL(ref(storage, normalizedPath));
    } catch (err) {
      console.warn('[MATERIAL] Failed to resolve object path:', value, err);
      return value; // Return original if resolution fails
    }
  }

  return value;
}

/**
 * Resolve a list of material URLs in parallel.
 * Filters out empty strings and returns only valid HTTP(S) URLs.
 */
export async function resolveMaterialList(urls: string[]): Promise<string[]> {
  const resolved = await Promise.all(urls.map((url) => resolveMaterialUrl(url)));
  // Filter to keep only non-empty HTTP(S) URLs
  return Array.from(
    new Set(resolved.filter((url) => url && (url.startsWith('http://') || url.startsWith('https://'))))
  );
}
