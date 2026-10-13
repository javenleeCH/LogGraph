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

/** 新建文件（iconfont 1024 网格，line 风格；源 src-tauri/icons/新建文件_line.svg） */
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
      <path d="M199.111111 967.125333a56.888889 56.888889 0 0 1-56.888889-56.888889v-796.444444a56.888889 56.888889 0 0 1 56.888889-56.888889h455.338667a56.419556 56.419556 0 0 1 37.546666 21.560889l2.304 2.275556c29.582222 28.444444 155.136 149.660444 167.623112 161.991111 1.123556 1.123556 2.147556 2.318222 3.086222 3.598222A71.779556 71.779556 0 0 1 881.777778 293.703111v616.533333a56.888889 56.888889 0 0 1-56.888889 56.888889H199.111111z m0-56.888889h625.777778v-526.222222H611.555556a56.888889 56.888889 0 0 1-56.888889-56.888889v-213.333333H199.111111v796.444444z m412.444445-583.111111h213.333333v-38.200889l-0.184889-0.085333L647.111111 113.792H611.555556v213.333333z m-128 426.666667v-99.555556h-99.555556a28.444444 28.444444 0 1 1 0-56.888888h99.555556v-99.555556a28.444444 28.444444 0 1 1 56.888888 0v99.555556h99.555556a28.444444 28.444444 0 1 1 0 56.888888h-99.555556v99.555556a28.444444 28.444444 0 1 1-56.888888 0z m398.222222-696.604444L729.6 56.888889H881.777778v0.298667z" />
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

/** 重命名（iconfont 1024 网格，fill 型；源 src-tauri/icons/重命名.svg） */
export function Rename({ size, ...p }: IconProps) {
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
      <path d="M850.261333 34.133333h-144.896v68.266667h144.896A71.338667 71.338667 0 0 1 921.6 173.056v676.522667A71.338667 71.338667 0 0 1 850.261333 921.6h-144.896v68.266667h144.896A139.776 139.776 0 0 0 989.866667 849.578667V173.056A139.776 139.776 0 0 0 850.261333 34.133333zM34.133333 173.056v676.522667A139.776 139.776 0 0 0 173.738667 989.866667h155.818666v-68.266667h-155.818666A71.338667 71.338667 0 0 1 102.4 849.578667V173.056A71.338667 71.338667 0 0 1 173.738667 102.4h155.818666V34.133333h-155.818666A139.776 139.776 0 0 0 34.133333 173.056z" />
      <path d="M719.018667 262.997333H304.981333a34.133333 34.133333 0 0 0 0 68.266667h166.741334a39.253333 39.253333 0 0 0 0 4.437333v436.565334a34.133333 34.133333 0 0 0 68.266666 0V335.701333a38.912 38.912 0 0 0 0-4.437333h179.029334a34.133333 34.133333 0 0 0 0-68.266667z" />
    </svg>
  );
}

/** 编辑（iconfont 1024 网格，fill 型；源 src-tauri/icons/编辑.svg） */
export function Edit({ size, ...p }: IconProps) {
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
      <path d="M343.291 560.334c-0.585 0.776-1.168 1.577-1.434 2.543l-45.09 170.896c-2.615 9.952 0.073 20.683 7.194 28.238 5.326 5.376 12.352 8.334 19.834 8.334 2.467 0 4.934-0.294 7.359-0.974l164.117-46.28c0.263 0 0.386 0.246 0.58 0.246 1.887 0 3.755-0.7 5.133-2.207l438.852-453.64C952.859 254.001 960 235.623 960 215.615c0-22.668-9.294-45.311-25.572-62.112l-41.432-42.911c-16.272-16.829-38.212-26.474-60.102-26.474-19.35 0-37.123 7.393-50.203 20.851L343.943 558.76c-0.462 0.437-0.341 1.07-0.652 1.574m553.58-337.287l-43.589 45.045-70.636-74.223 42.959-44.409c6.779-7.073 19.952-6.032 27.748 2.055l41.486 42.914c4.312 4.478 6.782 10.411 6.782 16.297-0.026 4.822-1.675 9.201-4.75 12.321m-475.557 344.41l316.655-327.405 70.709 74.268L492.606 641.1l-71.292-73.643z m-57.685 132.752l22.884-86.838 61.051 63.109-83.935 23.729z m561.043-297.381c-16.614 0-30.223 13.976-30.293 31.388v422.941c0 22.181-17.412 40.198-38.893 40.198H163.482c-21.453 0-38.937-18.017-38.937-40.198V166.824c0-22.209 17.485-40.226 38.937-40.226h445.681c16.701 0 30.268-14.046 30.268-31.312 0-17.244-13.567-31.287-30.268-31.287H158.855c-52.283 0-94.855 43.98-94.855 98.075V861.95c0 54.101 42.572 98.051 94.855 98.051h701.207c52.337 0 94.855-43.95 94.855-98.051V434c-0.047-17.196-13.634-31.172-30.245-31.172" />
    </svg>
  );
}

/** 日志文件（iconfont 1024 网格，fill 型；源 src-tauri/icons/日志.svg） */
export function LogFile({ size, ...p }: IconProps) {
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
      <path d="M897.28 170.666667h-750.933333c-28.16 0-51.2 23.04-51.2 51.2v665.6c0 28.16 23.04 51.2 51.2 51.2h750.933333c28.16 0 51.2-23.04 51.2-51.2V221.866667c0-28.16-22.613333-51.2-51.2-51.2z m-17.066667 699.733333h-716.8V238.933333h716.8v631.466667z" />
      <path d="M744.96 699.733333H333.226667c-18.346667 0-32.853333-14.933333-32.853334-32.853333v-2.133333c0-18.346667 14.933333-32.853333 32.853334-32.853334h411.733333c18.346667 0 32.853333 14.933333 32.853333 32.853334v2.133333c0 17.92-14.506667 32.853333-32.853333 32.853333zM743.68 546.133333h-221.866667c-18.773333 0-34.133333-15.36-34.133333-34.133333s15.36-34.133333 34.133333-34.133333h221.866667c18.773333 0 34.133333 15.36 34.133333 34.133333s-14.933333 34.133333-34.133333 34.133333zM718.08 307.2c-18.773333 0-34.133333-15.36-34.133333-34.133333V119.466667c0-18.773333 15.36-34.133333 34.133333-34.133334s34.133333 15.36 34.133333 34.133334v153.6c0 18.773333-14.933333 34.133333-34.133333 34.133333zM325.546667 307.2c-18.773333 0-34.133333-15.36-34.133334-34.133333V119.466667c0-18.773333 15.36-34.133333 34.133334-34.133334s34.133333 15.36 34.133333 34.133334v153.6c0 18.773333-14.933333 34.133333-34.133333 34.133333z" />
    </svg>
  );
}

/** 过滤器（iconfont 1024 网格，fill 型；源 src-tauri/icons/过滤.svg） */
export function Funnel({ size, ...p }: IconProps) {
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
      <path d="M697.856 509.147c0-14.628 10.533-26.624 23.771-26.843h241.664c13.312 0 24.138 12.069 24.138 26.843 0 14.848-10.826 26.844-24.138 26.844H721.627c-13.165-0.293-23.771-12.215-23.771-26.844zM924.086 89.82A27.502 27.502 0 0 0 899 73.143H64a27.502 27.502 0 0 0-25.088 16.676c-4.17 9.802-2.78 22.309 4.17 29.258l271.432 299.227v378.587a27.94 27.94 0 0 0 55.662 0V407.186a26.478 26.478 0 0 0-6.875-18.14L126.537 128.806h709.778L599.771 389.12a26.478 26.478 0 0 0-6.948 18.14V891.61L492.617 841.51a27.867 27.867 0 0 0-37.522 12.434 27.867 27.867 0 0 0 12.434 37.668l140.654 69.486a40.667 40.667 0 0 0 12.434 2.853 31.744 31.744 0 0 0 15.36-4.17 27.355 27.355 0 0 0 12.508-23.698V418.377l271.36-299.227c7.021-6.949 8.411-19.456 4.242-29.257z m-226.23 580.462c0-14.628 10.533-26.624 23.771-26.843h241.664c13.312 0 24.138 11.995 24.138 26.843 0 14.775-10.826 26.844-24.138 26.844H721.627c-13.165-0.22-23.771-12.215-23.771-26.844z m0 161.134c0-14.629 10.533-26.624 23.771-26.844h241.664c13.312 0 24.138 12.069 24.138 26.844 0 14.848-10.826 26.843-24.138 26.843H721.627c-13.165-0.292-23.771-12.141-23.771-26.843z" />
    </svg>
  );
}
