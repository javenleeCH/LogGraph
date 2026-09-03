"""生成 logGraph 应用图标源图（1024x1024 RGBA PNG），纯标准库实现，无第三方依赖。"""
import struct, zlib, math

SIZE = 1024
SS = 3  # 3x3 超采样抗锯齿

def in_rounded_rect(x, y, x0, y0, x1, y1, r):
    """判断归一化坐标 (x,y) 是否在圆角矩形内（边缘用距离软化）"""
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r

def sample(x, y):
    """返回 (r,g,b,a) 0..255。x,y 为归一化 [0,1]。"""
    # 圆角矩形（带 AA 软边）
    r = 0.23
    x0, y0, x1, y1 = 0.035, 0.035, 0.965, 0.965
    if not in_rounded_rect(x, y, x0, y0, x1, y1, r):
        return (0, 0, 0, 0)
    # 背景竖直渐变 #2a3350 -> #151a28
    t = (y - y0) / (y1 - y0)
    bg = (
        int(0x2a + (0x15 - 0x2a) * t),
        int(0x33 + (0x1a - 0x33) * t),
        int(0x50 + (0x28 - 0x50) * t),
    )
    # 菱形（45° 旋转正方形）：|dx|+|dy| <= half
    dx = abs(x - 0.5)
    dy = abs(y - 0.5)
    outer = dx + dy
    # 外菱形：浅色
    if outer <= 0.285:
        # 外菱形边缘软化
        edge = 0.285 - outer
        # 内菱形：深蓝
        if outer <= 0.135:
            inner_edge = 0.135 - outer
            # 内菱形 #3f54d1 -> #2c3e9e 渐变
            it = (y - 0.5) * 1.2 + 0.5
            it = min(max(it, 0.0), 1.0)
            col = (
                int(0x3f + (0x2c - 0x3f) * it),
                int(0x54 + (0x3e - 0x54) * it),
                int(0xd1 + (0x9e - 0xd1) * it),
            )
            return (col[0], col[1], col[2], 255)
        # 外菱形浅色 #dfe6ff
        return (0xdf, 0xe6, 0xff, 255)
    return (bg[0], bg[1], bg[2], 255)

def render_pixel(px, py):
    """对输出像素做 SSxSS 超采样平均。"""
    rs = gs = bs = as_ = 0
    for sy in range(SS):
        for sx in range(SS):
            x = (px + (sx + 0.5) / SS) / SIZE
            y = (py + (sy + 0.5) / SS) / SIZE
            r, g, b, a = sample(x, y)
            rs += r; gs += g; bs += b; as_ += a
    n = SS * SS
    return rs // n, gs // n, bs // n, as_ // n

def main():
    rows = []
    raw = bytearray()
    for py in range(SIZE):
        row = bytearray()
        for px in range(SIZE):
            r, g, b, a = render_pixel(px, py)
            row += bytes((r, g, b, a))
        raw += row
        rows.append(None)
    # 组装 PNG
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        c += struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
        return c
    ihdr = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)  # 8bit RGBA
    # 每行前置 filter byte 0
    scanlines = bytearray()
    stride = SIZE * 4
    for i in range(SIZE):
        scanlines += b'\x00' + bytes(raw[i*stride:(i+1)*stride])
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', ihdr)
    png += chunk(b'IDAT', zlib.compress(bytes(scanlines), 9))
    png += chunk(b'IEND', b'')
    with open('src-tauri/app-icon.png', 'wb') as f:
        f.write(png)
    print('written src-tauri/app-icon.png', len(png), 'bytes')

if __name__ == '__main__':
    main()
