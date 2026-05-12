'use client';

import { useRef, useState, useEffect, useCallback } from 'react';

interface ZoomableImageProps {
  src: string;
  alt: string;
  maxZoom?: number;
  minZoom?: number;
}

export function ZoomableImage({
  src,
  alt,
  maxZoom = 5,
  minZoom = 1,
}: ZoomableImageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [touchDistance, setTouchDistance] = useState(0);

  // Calculate distance between two touch points
  const getTouchDistance = (touch1: React.Touch, touch2: React.Touch): number => {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Handle wheel zoom (Ctrl/Cmd + scroll)
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (!containerRef.current) return;

      // Only zoom if Ctrl or Cmd is pressed
      if (!e.ctrlKey && !e.metaKey) return;

      e.preventDefault();

      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const zoomSpeed = 0.1;
      const scaleDelta = e.deltaY > 0 ? -zoomSpeed : zoomSpeed;
      const newScale = Math.max(minZoom, Math.min(maxZoom, scale + scaleDelta));

      if (newScale !== scale) {
        // Adjust position to zoom toward cursor
        const offsetX = (x - position.x) / scale;
        const offsetY = (y - position.y) / scale;

        setPosition({
          x: x - offsetX * newScale,
          y: y - offsetY * newScale,
        });

        setScale(newScale);
      }
    },
    [scale, position, minZoom, maxZoom]
  );

  // Handle touch pinch zoom
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const distance = getTouchDistance(e.touches[0], e.touches[1]);
      setTouchDistance(distance);
    } else if (e.touches.length === 1) {
      setIsDragging(true);
      setDragStart({
        x: e.touches[0].clientX - position.x,
        y: e.touches[0].clientY - position.y,
      });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // Pinch zoom
      const distance = getTouchDistance(e.touches[0], e.touches[1]);
      const zoomSpeed = 0.01;
      const scaleDelta = (distance - touchDistance) * zoomSpeed;
      const newScale = Math.max(minZoom, Math.min(maxZoom, scale + scaleDelta));

      if (newScale !== scale) {
        setScale(newScale);
        setTouchDistance(distance);
      }
    } else if (e.touches.length === 1 && isDragging && scale > minZoom) {
      // Pan
      const newX = e.touches[0].clientX - dragStart.x;
      const newY = e.touches[0].clientY - dragStart.y;

      setPosition({
        x: newX,
        y: newY,
      });
    }
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    setTouchDistance(0);
  };

  // Handle mouse drag
  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale <= minZoom) return; // Only allow dragging when zoomed
    
    setIsDragging(true);
    setDragStart({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || scale <= minZoom) return;

    const newX = e.clientX - dragStart.x;
    const newY = e.clientY - dragStart.y;

    setPosition({
      x: newX,
      y: newY,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Reset zoom and position
  const resetZoom = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  // Add wheel event listener to container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [handleWheel]);

  return (
    <div className="zoomable-image-container">
      <div
        ref={containerRef}
        className="zoomable-image-wrapper"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{
          cursor: isDragging ? 'grabbing' : scale > minZoom ? 'grab' : 'default',
        }}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          className="zoomable-image"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transformOrigin: '0 0',
            cursor: 'inherit',
          }}
          draggable={false}
        />
      </div>

      {/* Zoom controls */}
      <div className="zoomable-controls">
        <button
          className="zoomable-btn"
          onClick={() =>
            setScale((prev) => Math.max(minZoom, Math.min(maxZoom, prev - 0.5)))
          }
          disabled={scale <= minZoom}
          title="Zoom out"
          aria-label="Zoom out"
        >
          <i className="fas fa-minus" />
        </button>

        <span className="zoomable-level">{Math.round(scale * 100)}%</span>

        <button
          className="zoomable-btn"
          onClick={() =>
            setScale((prev) => Math.max(minZoom, Math.min(maxZoom, prev + 0.5)))
          }
          disabled={scale >= maxZoom}
          title="Zoom in"
          aria-label="Zoom in"
        >
          <i className="fas fa-plus" />
        </button>

        <button
          className="zoomable-btn"
          onClick={resetZoom}
          disabled={scale === 1 && position.x === 0 && position.y === 0}
          title="Reset zoom"
          aria-label="Reset zoom"
        >
          <i className="fas fa-undo" />
        </button>
      </div>

      {/* Help text */}
      <div className="zoomable-help">
        <small>
          💡 {scale > minZoom ? 'Drag to pan' : 'Use'} Ctrl+Scroll to zoom | Pinch to zoom
        </small>
      </div>
    </div>
  );
}
