/**
 * ReactFlow 自定义节点：filter 实体卡片
 * - 保留原有视觉（色点/label/计数/链角标/移除按钮）
 * - Handle：右侧主 source（普通连线）+ 右侧主 target + 自环专用双锚点（loop-src/loop-dst）
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { X } from '../Icon';
import styles from '../NodeCanvasView.module.css';

export type FilterNodeData = {
  label: string;
  color: string;
  enabled: boolean;
  matchCount: number;
  chainedCount: number;
  /** 悬停时移除按钮回调（由父级注入） */
  onRemove?: () => void;
};

type FilterNodeType = Node<FilterNodeData, 'filter'>;

function FilterNodeInner({ data }: NodeProps<FilterNodeType>) {
  return (
    <div
      className={styles.filterNode}
      style={{ borderLeftColor: data.color, width: 160 }}
    >
      <span className={styles.filterDot} style={{ background: data.color }} />
      <span className={styles.filterLabel} style={{ opacity: data.enabled ? 1 : 0.4 }}>
        {data.label}
      </span>
      <span className={styles.filterCount}>{data.matchCount}</span>
      {data.chainedCount > 0 && (
        <span className={styles.chainBadge} title="被完整链消耗的事件数">
          ⛓{data.chainedCount}
        </span>
      )}
      {data.onRemove && (
        <button
          className={styles.filterRemoveBtn}
          title="从本组移出"
          onClick={(e) => {
            e.stopPropagation();
            data.onRemove?.();
          }}
        >
          <X size={12} />
        </button>
      )}
      {/* 主连线锚点：右侧 source / 左侧 target */}
      <Handle type="source" position={Position.Right} id="out" style={{ right: -4 }} />
      <Handle type="target" position={Position.Left} id="in" style={{ left: -4 }} />
      {/* 自环锚点（方案 A）：右缘上下错开，供 periodic 自连 */}
      <Handle
        type="source"
        position={Position.Right}
        id="loop-src"
        style={{ right: -4, top: '28%', visibility: 'hidden' }}
      />
      <Handle
        type="target"
        position={Position.Right}
        id="loop-dst"
        style={{ right: -4, top: '72%', visibility: 'hidden' }}
      />
    </div>
  );
}

export const FilterNode = memo(FilterNodeInner);
