/**
 * ReactFlow 自定义边：五类约束（seq/not/and/or/periodic）
 * - seq/not/and/or：getBezierPath + EdgeLabelRenderer（标签/×按钮为 HTML，天然无 hover 死区）
 * - and/or 多目标：一条逻辑边对首目标画主干 path，其余目标以 data.extraTargets 的屏幕坐标画副支
 * - periodic：自环 circle（视觉与旧版一致），标签显示 周期±容差+缺口/抖动统计
 */
import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
  type Edge,
} from '@xyflow/react';

export type SeqEdgeData = {
  kind: 'seq' | 'not' | 'and' | 'or' | 'periodic';
  color?: string;
  /** 标签文本（时间窗/周期 + 统计），由父级算好注入 */
  label: string;
  /** and/or 副支目标坐标（流坐标） */
  extraTargets?: { x: number; y: number }[];
  onLabelClick?: () => void;
  onDelete?: () => void;
};

type SeqEdgeType = Edge<SeqEdgeData, 'seq'>;

function SeqEdgeInner(props: EdgeProps<SeqEdgeType>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const { screenToFlowPosition } = useReactFlow();

  // ---- periodic 自环：不画 path，画 circle ----
  if (data?.kind === 'periodic') {
    const cx = sourceX + 26;
    const cy = sourceY;
    return (
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%,-50%) translate(${cx}px,${cy}px)`,
            pointerEvents: 'all',
          }}
        >
          <svg width="56" height="52" style={{ overflow: 'visible', transform: 'translate(-26px,-16px)' }}>
            <circle
              cx="26"
              cy="16"
              r="14"
              fill="none"
              stroke={data.color ?? 'currentColor'}
              strokeWidth={2}
              opacity={0.85}
              style={{ cursor: 'pointer' }}
              onClick={data.onLabelClick}
            />
          </svg>
          <div
            className="seqEdgePeriodicLabel"
            style={{
              position: 'absolute',
              top: -20,
              left: '50%',
              transform: 'translateX(-50%)',
              whiteSpace: 'nowrap',
              fontSize: 11,
              cursor: 'pointer',
            }}
            onClick={data.onLabelClick}
          >
            {data.label}
          </div>
          <button
            className="seqEdgeDeleteBtn"
            title="删除心跳约束"
            style={{ position: 'absolute', top: -2, left: '50%', transform: 'translateX(-50%)' }}
            onClick={(e) => {
              e.stopPropagation();
              data.onDelete?.();
            }}
          >
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    );
  }

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const isNot = data?.kind === 'not';
  const markerEnd = isNot ? undefined : { url: undefined as unknown as string };
  void markerEnd; // 箭头由 CSS markerEnd 属性类控制（见 module.css）

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={undefined}
        style={
          isNot
            ? { stroke: 'var(--danger)', strokeWidth: 2, strokeDasharray: '4 3', opacity: 0.85 }
            : { stroke: data?.color, strokeWidth: 2, opacity: 0.85 }
        }
      />
      {/* and/or 副支：多目标分支路径（视觉扇形） */}
      {data?.extraTargets?.map((t, i) => {
        const tp = screenToFlowPosition({ x: 0, y: 0 }); // noop 保持 hook 顺序稳定
        void tp;
        const [subPath] = getBezierPath({
          sourceX,
          sourceY,
          sourcePosition,
          targetX: t.x,
          targetY: t.y,
          targetPosition,
        });
        return (
          <BaseEdge
            key={i}
            id={`${id}-sub-${i}`}
            path={subPath}
            markerEnd={undefined}
            style={{ stroke: data?.color, strokeWidth: 2, opacity: 0.85 }}
          />
        );
      })}
      {/* 标签 + ×：HTML 容器，零死区 */}
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan seqEdgeLabelWrap"
          style={{
            position: 'absolute',
            transform: `translate(-50%,-50%) translate(${labelX}px,${labelY - 12}px)`,
            pointerEvents: 'all',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span
            className="seqEdgeLabel"
            style={{ cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' }}
            onClick={data?.onLabelClick}
          >
            {data?.label}
          </span>
          <button
            className="seqEdgeDeleteBtn"
            title="切断连线"
            onClick={(e) => {
              e.stopPropagation();
              data?.onDelete?.();
            }}
          >
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const SeqEdge = memo(SeqEdgeInner);
