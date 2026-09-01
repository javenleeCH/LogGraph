/**
 * 平滑的 WASD 缩放/平移动画器，移植自 Perfetto 的
 * `wasd_navigation_handler.ts` + `animation.ts`。
 *
 * 核心思路：
 * 1. keydown 记录方向（不直接跳变），keyup 清除方向；
 *    按住期间持续累积目标值并随时间加速。
 * 2. 每帧用「弹簧追踪」step = (target - current) * SNAP_FACTOR，
 *    既平滑又能跟随加速的目标。
 * 3. 松手后方向清零，target 不再增长，current 靠弹簧自然趋近 target，
 *    当 |step| < 阈值时动画停止 —— 即松手后有一段缓出减速。
 *
 * 缩放以鼠标 X 为中心；平移按像素换算成时间增量。
 */

// 初次按下时至少移动多少（像素 / 缩放比）
const INITIAL_PAN_STEP_PX = 50;
const INITIAL_ZOOM_STEP = 0.1;

// 弹簧系数 [0..1]，越大越"硬"、越跟手，越小越"软"、越平滑
const SNAP_FACTOR = 0.4;

// 每毫秒速度增量（按住越久越快）
const ACCELERATION_PER_MS = 1 / 50;

// 动画默认时长（> 键盘重复间隔，避免松手前动画提前结束造成卡顿）
const DEFAULT_ANIMATION_DURATION = 700;

// 每帧最小步长（在加速度乘子之前）
const ZOOM_RATIO_PER_FRAME = 0.008;
const KEYBOARD_PAN_PX_PER_FRAME = 8;

const PAN_EPS = 0.1; // 平移 step 小于此值则停止
const ZOOM_EPS = 1e-6; // 缩放 step 小于此值则停止

type PanDir = 0 | -1 | 1; // 0=none, -1=left, 1=right
type ZoomDir = 0 | -1 | 1; // 0=none, 1=in(放大), -1=out(缩小)

export interface ZoomPanCallbacks {
  /** 平移：传入本帧应移动的像素数（正=右移时间，负=左移） */
  onPanned: (movedPx: number) => void;
  /** 缩放：传入鼠标 X（相对 canvas）与本帧缩放比增量（>0 放大，<0 缩小） */
  onZoomed: (mouseX: number, zoomRatioDelta: number) => void;
}

/**
 * 一个轻量的 RAF 动画。start() 幂等：若已在运行则只续命 endMs。
 */
class Animation {
  private startMs = 0;
  private endMs = 0;
  private rafId = 0;
  private boundStep = this.step.bind(this);

  constructor(private onStep: (timeSinceStartMs: number) => void) {}

  start(durationMs: number) {
    const now = performance.now();
    if (now <= this.endMs) {
      // 已在运行，只续命
      this.endMs = now + durationMs;
      return;
    }
    this.startMs = now;
    this.endMs = now + durationMs;
    if (!this.rafId) this.rafId = requestAnimationFrame(this.boundStep);
  }

  stop() {
    this.endMs = 0;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private step(nowMs: number) {
    if (nowMs >= this.endMs) {
      // 超时：仍执行最后一帧逻辑（让 onStep 自行决定是否 stop）
      this.rafId = 0;
      this.onStep(Math.max(Math.round(nowMs - this.startMs), 0));
      return;
    }
    this.onStep(Math.max(Math.round(nowMs - this.startMs), 0));
    if (this.endMs > 0) {
      this.rafId = requestAnimationFrame(this.boundStep);
    } else {
      this.rafId = 0;
    }
  }
}

/**
 * WASD 缩放/平移动画器。
 *
 * 用法：
 *   const anim = new ZoomPanAnimator({ onPanned, onZoomed });
 *   window.addEventListener('keydown', e => anim.onKeyDown(e));
 *   window.addEventListener('keyup', e => anim.onKeyUp(e));
 *   canvas.addEventListener('mousemove', e => anim.onMouseMove(e));
 *   // 组件卸载时调用 anim.dispose()
 */
export class ZoomPanAnimator {
  private mouseX: number | null = null;
  private panning: PanDir = 0;
  private panOffsetPx = 0;
  private targetPanOffsetPx = 0;
  private zooming: ZoomDir = 0;
  private zoomRatio = 0;
  private targetZoomRatio = 0;

  private panAnim = new Animation(this.onPanStep.bind(this));
  private zoomAnim = new Animation(this.onZoomStep.bind(this));

  constructor(private cb: ZoomPanCallbacks) {}

  /** 记录鼠标 X（相对 canvas 左上角），缩放以此为中心 */
  onMouseMove(mouseX: number) {
    this.mouseX = mouseX;
  }

  onMouseLeave() {
    this.mouseX = null;
  }

  private keyToPan(key: string): PanDir {
    if (key === 'a') return -1;
    if (key === 'd') return 1;
    return 0;
  }

  private keyToZoom(key: string): ZoomDir {
    if (key === 'w') return 1; // 放大
    if (key === 's') return -1; // 缩小
    return 0;
  }

  onKeyDown(e: KeyboardEvent) {
    // 输入框内不触发
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    )
      return;
    if (e.ctrlKey || e.metaKey) return;

    const key = e.key.toLowerCase();
    const pan = this.keyToPan(key);
    const zoom = this.keyToZoom(key);

    if (pan !== 0) {
      if (this.panning !== pan) {
        // 方向改变：重置弹簧
        this.panAnim.stop();
        this.panOffsetPx = 0;
        this.targetPanOffsetPx = pan * INITIAL_PAN_STEP_PX;
      }
      this.panning = pan;
      this.panAnim.start(DEFAULT_ANIMATION_DURATION);
    }

    if (zoom !== 0) {
      if (this.zooming !== zoom) {
        this.zoomAnim.stop();
        this.zoomRatio = 0;
        this.targetZoomRatio = zoom * INITIAL_ZOOM_STEP;
      }
      this.zooming = zoom;
      this.zoomAnim.start(DEFAULT_ANIMATION_DURATION);
    }

    if (pan !== 0 || zoom !== 0) e.preventDefault();
  }

  onKeyUp(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (this.keyToPan(key) === this.panning) this.panning = 0;
    if (this.keyToZoom(key) === this.zooming) this.zooming = 0;
  }

  private onPanStep(msSinceStart: number) {
    const step = (this.targetPanOffsetPx - this.panOffsetPx) * SNAP_FACTOR;
    if (this.panning !== 0) {
      const velocity = 1 + msSinceStart * ACCELERATION_PER_MS;
      // 至少和弹簧一样快，避免起步不连续
      const targetStep = Math.max(KEYBOARD_PAN_PX_PER_FRAME * velocity, step);
      this.targetPanOffsetPx += this.panning * targetStep;
    }
    this.panOffsetPx += step;
    if (Math.abs(step) > PAN_EPS) {
      this.cb.onPanned(step);
    } else {
      this.panAnim.stop();
    }
  }

  private onZoomStep(msSinceStart: number) {
    if (this.mouseX === null) {
      // 无鼠标位置：等有位置再缩放（动画继续空转无意义，停止）
      this.zoomAnim.stop();
      return;
    }
    const step = (this.targetZoomRatio - this.zoomRatio) * SNAP_FACTOR;
    if (this.zooming !== 0) {
      const velocity = 1 + msSinceStart * ACCELERATION_PER_MS;
      const targetStep = Math.max(ZOOM_RATIO_PER_FRAME * velocity, step);
      this.targetZoomRatio += this.zooming * targetStep;
    }
    this.zoomRatio += step;
    if (Math.abs(step) > ZOOM_EPS) {
      this.cb.onZoomed(this.mouseX, step);
    } else {
      this.zoomAnim.stop();
    }
  }

  dispose() {
    this.panAnim.stop();
    this.zoomAnim.stop();
  }
}
