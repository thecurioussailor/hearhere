"""Generate HearHere PNG icons with no dependencies: python3 scripts/make_icons.py"""
import math, os, struct, zlib

BG = (255, 90, 54)
FG = (255, 255, 255)
SPEAKER = [(0.20, 0.40), (0.33, 0.40), (0.50, 0.25), (0.50, 0.75), (0.33, 0.60), (0.20, 0.60)]
WAVES = [(0.15, 0.215), (0.27, 0.335)]  # inner/outer radius of each arc
CENTER = (0.47, 0.50)

def in_rounded(x, y, r=0.22):
    cx = min(max(x, r), 1 - r); cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r and 0 <= x <= 1 and 0 <= y <= 1

def in_poly(x, y, pts):
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]; xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside

def in_wave(x, y):
    dx, dy = x - CENTER[0], y - CENTER[1]
    if dx <= 0 or abs(math.atan2(dy, dx)) > math.radians(48):
        return False
    d = math.hypot(dx, dy)
    return any(a <= d <= b for a, b in WAVES)

def render(size, ss=4):
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            bg = fg = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + .5) / ss) / size
                    y = (py + (sy + .5) / ss) / size
                    if in_rounded(x, y):
                        bg += 1
                        if in_poly(x, y, SPEAKER) or in_wave(x, y):
                            fg += 1
            n = ss * ss
            a = bg / n
            if bg:
                t = fg / bg
                rgb = [round(BG[k] * (1 - t) + FG[k] * t) for k in range(3)]
            else:
                rgb = [0, 0, 0]
            row += bytes(rgb + [round(a * 255)])
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
