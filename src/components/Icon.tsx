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

export function Search({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </Svg>
  );
}

export function Keyboard({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </Svg>
  );
}

export function Copy({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5A1.5 1.5 0 0 0 5.5 15" />
    </Svg>
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

export function Link({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Svg>
  );
}

export function AlertTriangle({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4M12 17h.01" />
    </Svg>
  );
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

export function Clock({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </Svg>
  );
}

export function Type({ size, ...p }: IconProps) {
  return (
    <Svg size={size} {...p}>
      <path d="M4 7V5h16v2M12 5v14M9 19h6" />
    </Svg>
  );
}

/** 新建文件（iconfont 1024 网格，fill 型；源 src-tauri/icons/新建文件.svg） */
export function NewFile({ size, ...p }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      fill="currentColor"
      aria-hidden="true"
      {...p}
    >
      <path d="M881.25604437 888.08037781V290.64735687c0.03837375-0.73678031 0.03837375-1.47931688 1e-8-2.21993437-0.01822781-4.89939844-1.50617906-9.63570656-4.18756125-13.341675L708.96453781 99.81642031c-1.3382925-1.70284594-2.90778844-3.11308969-4.64613-4.17892687l-3.49011375-2.78595094h-418.5277575c-19.003755 0.16788656-34.30634062 18.71019469-34.18642218 41.438145v313.84353375h58.02146156V162.9617675h363.20206875V308.35311219c0 3.79518656 1.69517063 7.43591812 4.6797075 10.10962594 2.91834094 2.67850406 6.90060094 4.18468313 11.06897531 4.1933175h138.38329594V871.48171156h-517.3340475v-80.87700562h-58.02146156v97.46128125h-0.01343063v10.55476406c-0.06235781 8.6619675 3.50354438 16.99104 9.91104 23.15869875 6.41133281 6.16382062 15.13853625 9.66352781 24.26482875 9.7230075h565.00029c19.003755-0.12375563 34.30634062-14.844975 34.18546219-32.88170625v-10.54037344h-0.20626032z" />
      <path d="M302.85460062 491.69440719v259.02438187h-47.02923468v-259.02438187z" />
      <path d="M408.85217469 644.72025594h-259.02438188v-47.02923469h259.02438188z" />
    </svg>
  );
}

/** 新建文件夹（iconfont 1024 网格，fill 型；源 src-tauri/icons/新建文件夹.svg） */
export function NewFolder({ size, ...p }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      fill="currentColor"
      aria-hidden="true"
      {...p}
    >
      <path d="M703.8 547.8h-167v-167c0-13.8-11.2-25-25-25s-25 11.2-25 25v167h-167c-13.8 0-25 11.2-25 25s11.2 25 25 25h167v167c0 13.8 11.2 25 25 25s25-11.2 25-25v-167h167c13.8 0 25-11.2 25-25s-11.2-25-25-25z" />
      <path d="M833.3 234.1H530.8l-29.6-58.5c-10.4-20.6-26.4-37.9-46.1-50.1-19.7-12.1-42.3-18.5-65.5-18.5H188.7c-68.9 0-125 56.1-125 125v513.5c0 96.5 78.5 175 175 175h544.7c96.5 0 175-78.5 175-175V359.1c-0.1-68.9-56.1-125-125.1-125z m75 511.5c0 68.9-56.1 125-125 125H238.7c-68.9 0-125-56.1-125-125V232c0-41.4 33.6-75 75-75h200.9c28.4 0 54.1 15.8 66.9 41.1l36.6 72.2c4.3 8.4 12.9 13.7 22.3 13.7h317.9c41.4 0 75 33.6 75 75v386.6z" />
    </svg>
  );
}
