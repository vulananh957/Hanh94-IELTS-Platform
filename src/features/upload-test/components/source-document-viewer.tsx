'use client';

import Image from 'next/image';
import { useEffect, useMemo } from 'react';
import type { TestSkill, UploadFileRef } from '../types';

interface SourceDocumentViewerProps {
  skill: TestSkill | null;
  sourceFile: File | null;
  sourceDocument: UploadFileRef | null;
  listeningAudioFiles: UploadFileRef[];
}

function isPdfLike(fileName: string, fileType?: string): boolean {
  const byMime = fileType === 'application/pdf';
  const byName = fileName.toLowerCase().endsWith('.pdf');
  const byDataUrl = fileName.startsWith('data:application/pdf');
  return byMime || byName || byDataUrl;
}

function isWordLike(fileName: string, fileType?: string): boolean {
  return (
    fileType === 'application/msword'
    || fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || /\.(doc|docx)$/i.test(fileName)
  );
}

function isImageLike(fileName: string, fileType?: string): boolean {
  if (String(fileType || '').startsWith('image/')) return true;
  if (/^data:image\//i.test(fileName)) return true;
  return /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(fileName);
}

function detectModeFromDataUrl(dataUrl: string | null | undefined): 'pdf' | 'image' | 'unsupported' {
  if (!dataUrl) return 'unsupported';

  // Standard data URL prefix
  if (/^data:application\/pdf/i.test(dataUrl)) return 'pdf';
  if (/^data:image\//i.test(dataUrl)) return 'image';

  // Firebase / CDN download URL — find the filename in the path or query
  const lc = dataUrl.toLowerCase();

  // Firebase: o/<encoded-filename>?alt=media...
  const firebaseMatch = lc.match(/o\/([^?]+)/);
  const fileName = firebaseMatch ? firebaseMatch[1] : lc;

  // Strip encoding (e.g. "Reading%20Test.pdf" → "Reading Test.pdf")
  const decoded = decodeURIComponent(fileName);

  if (/\.pdf(\?|$|#|$)/i.test(decoded)) return 'pdf';
  if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$|#|$)/i.test(decoded)) return 'image';
  return 'unsupported';
}

function buildPdfPreviewSrc(src: string): string {
  const pdfPreviewParams = 'toolbar=0&navpanes=0&scrollbar=1&view=FitH&zoom=page-width';

  if (src.includes('#')) {
    return `${src}&${pdfPreviewParams}`;
  }

  return `${src}#${pdfPreviewParams}`;
}

function useObjectUrlFromFile(file: File | null): string | null {
  const objectUrl = useMemo(() => {
    if (!file) return null;
    return URL.createObjectURL(file);
  }, [file]);

  useEffect(() => {
    return () => {
      // In dev Strict Mode React remounts components, and revoking too early can trigger
      // transient blob:// ERR_FILE_NOT_FOUND in media previews.
      if (objectUrl && process.env.NODE_ENV === 'production') {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [objectUrl]);

  return objectUrl;
}

function usePreviewUrl(ref: UploadFileRef | null): string | null {
  const objectUrl = useMemo(() => {
    if (!ref) return null;

    if (ref.url) {
      return ref.url;
    }

    if (ref.dataUrl) {
      return ref.dataUrl;
    }

    if (ref.file) {
      return URL.createObjectURL(ref.file);
    }

    return null;
  }, [ref]);

  useEffect(() => {
    return () => {
      // Keep dev previews stable during Strict Mode remount; cleanup remains enabled in production.
      if (objectUrl && ref?.file && process.env.NODE_ENV === 'production') {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [objectUrl, ref]);

  return objectUrl;
}

function ListeningAudioRow({ fileRef, index }: { fileRef: UploadFileRef; index: number }) {
  const previewUrl = usePreviewUrl(fileRef);
  const fileName = fileRef.name || `listening-part-${index + 1}`;

  return (
    <div className="source-viewer-audio-card">
      <div className="source-viewer-audio-meta">
        <span className="source-viewer-audio-part">Part {index + 1}</span>
        <div className="source-viewer-audio-name">{fileName}</div>
        <div className="source-viewer-audio-size">
          {fileRef.size ? `${Math.max(1, Math.round(fileRef.size / 1024))} KB` : 'Audio file'}
        </div>
      </div>

      {previewUrl ? <audio controls src={previewUrl} className="source-viewer-audio-player" /> : null}
    </div>
  );
}

export function SourceDocumentViewer({ skill, sourceFile, sourceDocument, listeningAudioFiles }: SourceDocumentViewerProps) {
  const previewSourceFile = sourceFile || sourceDocument?.file || null;
  const objectUrl = useObjectUrlFromFile(previewSourceFile);

  const sourceDataUrl = sourceDocument?.dataUrl ?? null;

  const mode = useMemo(() => {
    if (skill === 'listening') return 'listening';
    if (!previewSourceFile && !sourceDocument) return 'empty';
    if (sourceDataUrl) return detectModeFromDataUrl(sourceDataUrl);
    if (previewSourceFile && isPdfLike(previewSourceFile.name, previewSourceFile.type)) return 'pdf';
    if (previewSourceFile && isImageLike(previewSourceFile.name, previewSourceFile.type)) return 'image';
    if (previewSourceFile && isWordLike(previewSourceFile.name, previewSourceFile.type)) return 'unsupported';
    if (sourceDocument && isPdfLike(sourceDocument.name, sourceDocument.type)) return 'pdf';
    if (sourceDocument && isImageLike(sourceDocument.name, sourceDocument.type)) return 'image';
    if (sourceDocument && isWordLike(sourceDocument.name, sourceDocument.type)) return 'unsupported';
    return 'unsupported';
  }, [previewSourceFile, skill, sourceDocument, sourceDataUrl]);

  const previewSrc = useMemo(() => {
    if (objectUrl) return objectUrl;
    if (sourceDataUrl) return sourceDataUrl;
    return null;
  }, [objectUrl, sourceDataUrl]);

  const listeningFiles = useMemo(() => listeningAudioFiles.filter(Boolean), [listeningAudioFiles]);

  return (
    <div className="source-viewer-card">
      <div className="source-viewer-head">
        <h3 className="source-viewer-title">
          {skill === 'listening' ? 'Listening Preview' : 'Source Preview'}
        </h3>
      </div>

      {skill === 'listening' && sourceDocument ? (
        <p className="source-viewer-subnote">
          Listening source loaded separately for question generation.
        </p>
      ) : null}

      <div className="source-viewer-frame">
        {mode === 'empty' ? (
          <div className="source-viewer-empty">
            Upload PDF or image and run extraction to enable split-screen review.
          </div>
        ) : null}

        {mode === 'pdf' && previewSrc ? (
          <iframe
            title="Source PDF preview"
            src={buildPdfPreviewSrc(previewSrc)}
            className="source-viewer-iframe"
          />
        ) : null}

        {mode === 'image' && previewSrc ? (
          <div className="source-viewer-image-wrap">
            <Image
              src={previewSrc}
              alt="Uploaded source"
              fill
              unoptimized
              className="object-contain"
            />
          </div>
        ) : null}

        {mode === 'listening' ? (
          <div className="source-viewer-listening-stack">
            {listeningFiles.length > 0 ? (
              listeningFiles.map((fileRef, index) => (
                <ListeningAudioRow key={`${fileRef.name}-${index}`} fileRef={fileRef} index={index} />
              ))
            ) : (
              <div className="source-viewer-empty">
                Upload all 4 listening audio files to preview them here.
              </div>
            )}
          </div>
        ) : null}

        {mode === 'unsupported' ? (
          <div className="source-viewer-unsupported">
            This file type is not previewable. Use PDF, DOC/DOCX, or image.
          </div>
        ) : null}
      </div>
    </div>
  );
}
