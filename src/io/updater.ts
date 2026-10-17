/**
 * 自签更新通道。
 *
 * 用 Tauri updater 的 minisign 密钥对签名——**自生成、不需要付费代码签名证书**。
 * 传统代码签名（Windows Authenticode / Apple Developer ID）要花钱且与代码质量
 * 无关，那条路不做；但「装了之后感知不到新版本」是真问题，自签更新正好能解决，
 * 且不牺牲可下载性（用户仍需在 SmartScreen / Gatekeeper 上放行一次，与之前一致）。
 *
 * 分工：
 * - 公钥在 `src-tauri/tauri.conf.json`（可公开，客户端用它校验产物签名）
 * - 私钥由 CI 持有（GitHub Secrets 的 TAURI_SIGNING_PRIVATE_KEY）
 * - 更新清单 `latest.json` 由 tauri-action 随 release 自动产出
 *
 * 刻意不自动重启：下载安装完只提示重启。用户可能正开着日志在分析，中途重启
 * 会打断工作；让他们自己决定何时重启，比我们替他们决定安全。
 */
import { check } from '@tauri-apps/plugin-updater';
import { ask } from '@tauri-apps/plugin-dialog';
import { isTauri } from '../lib/tauri';
import { toast, beginBusy } from '../store/uiStore';

/**
 * 检查更新。
 * @param manual true=用户手动点击（无更新也要明说）；false=启动静默检查（无更新则不出声）
 */
export async function checkForUpdate(manual: boolean): Promise<void> {
  // 浏览器版没有更新通道（Web 端刷新即是最新）
  if (!isTauri()) {
    if (manual) toast.info('网页版无需更新，刷新页面即是最新版本');
    return;
  }
  const endBusy = beginBusy('检查更新…');
  try {
    const update = await check();
    if (!update) {
      if (manual) toast.success('已是最新版本');
      return;
    }
    const ok = await ask(`发现新版本 ${update.version}，是否现在更新？`, {
      title: 'logGraph 更新',
      kind: 'info',
    });
    if (!ok) return;
    // 换新进度文案（beginBusy 是一次性的，结束旧的再起新的）
    endBusy();
    const endDownload = beginBusy(`下载 ${update.version}…`);
    try {
      await update.downloadAndInstall();
      toast.success(`已更新到 ${update.version}，重启后生效`, '重启前当前窗口仍可继续使用');
    } catch (e) {
      toast.error('下载更新失败', String(e));
    } finally {
      endDownload();
    }
  } catch (e) {
    // 网络不通 / 还没发布过带签名的 release：手动点击才说出来，静默检查不出声
    if (manual) toast.warn('检查更新失败', String(e));
  } finally {
    endBusy(); // 幂等：内部可能已调过一次
  }
}
