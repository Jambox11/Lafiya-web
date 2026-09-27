'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface QRCardDisplayProps {
  value: string;
  size?: number;
  label?: string;
}

/**
 * Renders a QR code for the given value.
 *
 * Accessibility note: in Windows High Contrast / forced-colors mode the OS
 * overrides author colours. A QR code must remain black-on-white to stay
 * scannable, so we opt out of forced colour adjustment on the canvas and
 * paint an explicit white background with black modules.
 */
export default function QRCardDisplay({
  value,
  size = 220,
  label = 'QR code',
}: QRCardDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    QRCode.toCanvas(
      canvas,
      value,
      {
        width: size,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      },
      (err) => {
        if (cancelled) return;
        setError(err ? 'Unable to render QR code.' : null);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [value, size]);

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="rounded-lg border border-neutral-300 bg-white p-3 forced-colors:border-[CanvasText]"
        style={{ forcedColorAdjust: 'none' }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={label}
          className="block h-auto w-full max-w-full"
          style={{ forcedColorAdjust: 'none' }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 forced-colors:text-[CanvasText]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
