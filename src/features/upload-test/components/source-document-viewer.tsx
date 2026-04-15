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
  return byMime || byName;
}

function isWordLike(fileName: string, fileType?: string): boolean {
  return (
    fileType === 'application/msword'
    || fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || /\.(doc|docx)$/i.test(fileName)
  );
}

function isImageLike(fileName: string, fileType?: string): boolean {
  return String(fileType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(fileName);
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

  const mode = useMemo(() => {
    if (skill === 'listening') return 'listening';
    if (!previewSourceFile && !sourceDocument) return 'empty';
    if (previewSourceFile && isPdfLike(previewSourceFile.name, previewSourceFile.type)) return 'pdf';
    if (previewSourceFile && isImageLike(previewSourceFile.name, previewSourceFile.type)) return 'image';
    if (previewSourceFile && isWordLike(previewSourceFile.name, previewSourceFile.type)) return 'unsupported';
    if (sourceDocument && isPdfLike(sourceDocument.name, sourceDocument.type)) return 'pdf';
    if (sourceDocument && isImageLike(sourceDocument.name, sourceDocument.type)) return 'image';
    if (sourceDocument && isWordLike(sourceDocument.name, sourceDocument.type)) return 'unsupported';
    return 'unsupported';
  }, [previewSourceFile, skill, sourceDocument]);

  const listeningFiles = useMemo(() => listeningAudioFiles.filter(Boolean), [listeningAudioFiles]);

  return (
    <div className="source-viewer-card">
      <div className="source-viewer-head">
        <div>
          <h3 className="source-viewer-title">
            {skill === 'listening' ? 'Listening Preview' : 'Source Preview'}
          </h3>
          <p className="source-viewer-subtitle">
            {skill === 'listening'
              ? 'Four audio files are previewed here. The extraction PDF/image stays separate.'
              : 'Left pane for visual cross-check while editing extracted answers.'}
          </p>
        </div>
      </div>

      {skill !== 'listening' && sourceDocument ? (
        <div className="source-viewer-file-meta">
          <div className="source-viewer-file-name">{sourceDocument.name}</div>
          <div className="source-viewer-file-size">
            {sourceDocument.size ? `${Math.max(1, Math.round(sourceDocument.size / 1024))} KB` : 'Extraction source'}
          </div>
        </div>
      ) : null}

      {skill === 'listening' && sourceDocument ? (
        <p className="source-viewer-subnote">
          Extraction source loaded separately for question generation.
        </p>
      ) : null}

      <div className="source-viewer-frame">
        {mode === 'empty' ? (
          <div className="source-viewer-empty">
            Upload PDF or image and run extraction to enable split-screen review.
          </div>
        ) : null}

        {mode === 'pdf' && objectUrl ? (
          <iframe
            title="Source PDF preview"
            src={`${objectUrl}#toolbar=0&navpanes=0&scrollbar=1`}
            className="source-viewer-iframe"
          />
        ) : null}

        {mode === 'image' && objectUrl ? (
          <div className="source-viewer-image-wrap">
            <Image
              src={objectUrl}
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
