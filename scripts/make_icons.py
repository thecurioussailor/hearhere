"""Generate HearHere bloom icons with no dependencies: python3 scripts/make_icons.py

The mark: a coral six-petal flower with a white centre. Sound blooming out of text.
Geometry matches src/bloom.js (viewBox 0..100).
"""
import math, os, struct, zlib

CORAL = (242, 114, 104)
WHITE = (255, 255, 255)
PETALS, DIST, PETAL_R, CORE_R, DOT_R = 6, 26, 21, 24, 9

CIRCLES = [(50 + DIST * math.cos(2 * math.pi * i / PETALS - math.pi / 2),
            50 + DIST * math.sin(2 * math.pi * i / PETALS - math.pi / 2), PETAL_R) for i in range(PETALS)]
CIRCLES.append((50, 50, CORE_R))

def in_flower(x, y):
    return any((x - cx) ** 2 + (y - cy) ** 2 <= r * r for cx, cy, r in CIRCLES)

def in_dot(x, y, r):
    return (x - 50) ** 2 + (y - 50) ** 2 <= r * r

def render(size, ss=5):
    # small sizes: slightly larger dot so it survives at 16px
    dot = DOT_R * (1.35 if size <= 16 else 1.15 if size <= 32 else 1)
    scale = 100 / size
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            cover = white = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + .5) / ss) * scale
                    y = (py + (sy + .5) / ss) * scale
                    if in_flower(x, y):
                        cover += 1
                        if in_dot(x, y, dot):
                            white += 1
            n = ss * ss
            if cover:
                t = white / cover
                rgb = [round(CORAL[k] * (1 - t) + WHITE[k] * t) for k in range(3)]
            else:
                rgb = [0, 0, 0]
            row += bytes(rgb + [round(cover / n * 255)])
        rows.append(bytes(row))
    return rows

def png(size, rows):
    raw = b''.join(b'\x00' + r for r in rows)
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

out = os.path.join(os.path.dirname(__file__), '..', 'icons')
os.makedirs(out, exist_ok=True)
for s in (16, 32, 48, 128):
    with open(os.path.join(out, f'icon{s}.png'), 'wb') as f:
        f.write(png(s, render(s)))
print('icons written')
