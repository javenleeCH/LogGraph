import type { SVGProps, ReactNode } from 'react';

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

function Svg({ size = 16, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ChevronDown({ size, ...p }: IconProps) {
  return <Svg size={size} {...p}><path d="m6 9 6 6 6-6" /></Svg>;
}

export function ChevronRight({ size, ...p }: IconProps) {
  return <Svg size={size} {...p}><path d="m9 6 6 6-6 6" /></Svg>;
}

export function ChevronLeft({ size, ...p }: IconProps) {
  return <Svg size={size} {...p}><path d="m15 6-6 6 6 6" /></Svg>;
}

export function Plus({ size, ...p }: IconProps) {
  return <Svg size={size} {...p}><path d="M12 5v14M5 12h14" /></Svg>;
}

export function X({ size, ...p }: IconProps) {
  return <Svg size={size} {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
}

export function Check({ size, ...p }: IconProps) {
  return <Svg size={size} {...p}><path d="M20 6 9 17l-5-5" /></Svg>;
}

export function ArrowRight({ size, ...p }: IconProps) {
  return <Svg size={size} {...p}><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></Svg>;
}

export function ArrowUturnLeft({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M3 8h11a6 6 0 0 1 0 12H8" />
      <path d="m7 4-4 4 4 4" />
    </Svg>
  );
}

export function Folder({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Svg>
  );
}

export function FolderOpen({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M4 5a2 2 0 0 1 2-2h5.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
      <path d="m6 14 1.5-3.5A2 2 0 0 1 9.36 9H19a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2v-9" />
    </Svg>
  );
}

export function FileText({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7l-5-5Z" />
      <path d="M14 2v5h5" />
      <path d="M8 13h8M8 17h5" />
    </Svg>
  );
}

export function Eye({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function EyeOff({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <path d="m2 2 20 20" />
    </Svg>
  );
}

export function Pencil({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z" />
    </Svg>
  );
}

export function Trash({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

export function Table({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18" />
    </Svg>
  );
}

export function BarChart({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M3 3v18h18" />
      <path d="M18 17V9M13 17V5M8 17v-3" />
    </Svg>
  );
}

export function Layers({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 16 9 5 9-5" />
    </Svg>
  );
}

export function Filter({ size, ...p }: IconProps) {
  return <Svg size={size} {...p}><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3Z" /></Svg>;
}

export function Save({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </Svg>
  );
}

export function Database({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </Svg>
  );
}

export function Grid({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
    </Svg>
  );
}

export function Columns({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <rect x="3" y="3" width="5" height="18" rx="1" />
      <rect x="10" y="3" width="5" height="18" rx="1" />
      <rect x="17" y="3" width="4" height="18" rx="1" />
    </Svg>
  );
}

export function AlignCenter({ size, ...p }: IconProps) {
  return <Svg size={size} {...p}><path d="M3 6h18M6 12h12M5 18h14" /></Svg>;
}

export function Globe({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
    </Svg>
  );
}

export function Diamond({ size, ...p }: IconProps) {
  return <Svg size={size} {...p}><path d="M12 2 22 12 12 22 2 12 12 2Z" /></Svg>;
}

export function Info({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </Svg>
  );
}

export function FolderTree({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M20 10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-7.9a2 2 0 0 0-1.69.9l-.82 1.2A2 2 0 0 1 7.9 7H4a2 2 0 0 0-2 2v1" />
      <path d="M2 10v9a2 2 0 0 0 2 2h7" />
      <path d="M12 12h7a2 2 0 0 1 2 2v7h-9" />
    </Svg>
  );
}

export function Undo({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M3 7v6h6" />
      <path d="M3 13a9 9 0 1 0 3-7.7L3 8" />
    </Svg>
  );
}

export function Maximize({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
    </Svg>
  );
}

export function Sun({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </Svg>
  );
}

export function Moon({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </Svg>
  );
}
