'use client';

import { useId } from 'react';

interface ECGGraphProps {
  data: number[];
  color?: string;
  label: string;
  unit: string;
  height?: number;
}

export default function ECGGraph({
  data,
  color = '#22c55e',
  label,
  unit,
  height = 80,
}: ECGGraphProps) {
  const width = 320;
  const padding = 4;
  const drawH = height - padding * 2;
  const gradId = useId();

  const max = Math.max(...data, 1);
  const points = data.map((val, i) => {
    const x =
      padding + (i / Math.max(data.length - 1, 1)) * (width - padding * 2);
    const y = padding + drawH - (val / max) * drawH;
    return `${x},${y}`;
  });

  const linePath = points.join(' ');
  const areaPath = `${padding},${padding + drawH} ${linePath} ${width - padding},${padding + drawH}`;

  const current = data[data.length - 1] ?? 0;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-slate-500 dark:text-slate-400">{label}</span>
        <span className="font-mono text-slate-700 dark:text-slate-300">
          {current.toFixed(1)}
          {unit}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ display: 'block' }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map((frac) => (
          <line
            key={frac}
            x1={padding}
            y1={padding + drawH * (1 - frac)}
            x2={width - padding}
            y2={padding + drawH * (1 - frac)}
            stroke="currentColor"
            className="text-slate-200 dark:text-slate-700"
            strokeWidth="0.5"
          />
        ))}
        {/* Area fill */}
        <polygon points={areaPath} fill={`url(#${gradId})`} />
        {/* Waveform line */}
        <polyline
          points={linePath}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        {/* Current value dot */}
        {points.length > 0 && (
          <circle
            cx={points[points.length - 1].split(',')[0]}
            cy={points[points.length - 1].split(',')[1]}
            r="2.5"
            fill={color}
          />
        )}
      </svg>
    </div>
  );
}
