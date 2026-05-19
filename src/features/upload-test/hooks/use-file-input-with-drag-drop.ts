import { useCallback, useRef, useState, useEffect } from 'react';

interface UseFileInputWithDragDropOptions {
  onFileSelect: (file: File | null) => void;
  acceptedTypes?: string[];
}

export function useFileInputWithDragDrop({
  onFileSelect,
  acceptedTypes = [],
}: UseFileInputWithDragDropOptions) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);

  const isAcceptedFile = useCallback(
    (file: File): boolean => {
      if (acceptedTypes.length === 0) return true;

      // Check MIME type
      if (acceptedTypes.includes(file.type)) return true;

      // Check by file extension
      const fileName = file.name.toLowerCase();
      for (const acceptType of acceptedTypes) {
        if (acceptType.startsWith('.')) {
          if (fileName.endsWith(acceptType)) return true;
        }
        // Also check if acceptType is a wildcard like "audio/*", "image/*"
        if (acceptType.endsWith('/*')) {
          const typePrefix = acceptType.slice(0, -2); // Remove the "*"
          if (file.type.startsWith(typePrefix)) return true;
        }
      }

      return false;
    },
    [acceptedTypes]
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) {
        onFileSelect(null);
        return;
      }

      const file = files[0];
      if (isAcceptedFile(file)) {
        onFileSelect(file);
      } else {
        console.warn(`File type not accepted: ${file.type}`);
        onFileSelect(null);
      }
    },
    [onFileSelect, isAcceptedFile]
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);

      const files = e.dataTransfer.files;
      console.log('[DragDrop] Drop event:', { filesCount: files?.length, fileNames: Array.from(files || []).map(f => f.name) });
      if (files && files.length > 0) {
        handleFiles(files);
      }
    },
    [handleFiles]
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent | React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            if (isAcceptedFile(file)) {
              onFileSelect(file);
            } else {
              console.warn(`Pasted file type not accepted: ${file.type}`);
            }
            break;
          }
        }
      }
    },
    [onFileSelect, isAcceptedFile]
  );

  // Setup paste listener on the zone div
  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;

    zone.addEventListener('paste', handlePaste as any);
    return () => zone.removeEventListener('paste', handlePaste as any);
  }, [handlePaste]);

  // Reset drag counter when unmounting
  useEffect(() => {
    return () => {
      dragCounterRef.current = 0;
    };
  }, []);

  return {
    isDragging,
    inputRef,
    zoneRef,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handlePaste,
    trigger: () => inputRef.current?.click(),
  };
}
