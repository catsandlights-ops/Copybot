"""Draws Remora's app icon: a pixel-art remora on the dark tile with the rainbow border.
   python3 scripts/make-icon.py [out.png]      (needs Pillow; writes build/icon.png by default)
The same sprite is used in the app's sidebar logo and the phone icon (ui/index.html, src/server-phone.ts)."""
import sys
from PIL import Image, ImageDraw

# The remora, facing right: its striped suction disc on top of the head, a long body, a forked tail.
# K outline, D dark back, M body, L light flank, C belly, S/T suction-disc stripes, W eye shine, B bubbles.
SPRITE = [
    "....................BB..",
    "...................B..B.",
    "...................B..B.",
    "....................BB..",
    "................B.......",
    "........................",
    "...........KKKKKKKKK....",
    "KK........KSTSTSTSTSK...",
    "KDK....KKKKDDDDDDDDDKK..",
    "KDDK.KKDDDDDDMMMMMMMMMK.",
    ".KDDKDDMMMMMMMMMMMMWWMKK",
    "..KDDMMMMLLLLLLLLLLWKLLK",
    ".KDDKLLLLLCCCCCCCCCCCCCK",
    "KDDK.KKCCKKCCCCCCCCCCCK.",
    "KDK....KKK.KKKKKKKKKKK..",
    "KK......................",
]
PAL = {
    'K': (7, 3, 26), 'D': (42, 74, 158), 'M': (64, 140, 230), 'L': (127, 216, 255),
    'C': (247, 233, 196), 'S': (255, 246, 220), 'T': (180, 175, 204), 'W': (255, 255, 255), 'B': (127, 216, 255), 'F': (31, 52, 120),
}
RAINBOW = [(255, 46, 85), (255, 138, 20), (255, 224, 20), (31, 224, 106), (18, 210, 255), (61, 107, 255), (163, 71, 255)]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rainbow_at(t):
    t = max(0.0, min(1.0, t)) * (len(RAINBOW) - 1)
    i = min(int(t), len(RAINBOW) - 2)
    return lerp(RAINBOW[i], RAINBOW[i + 1], t - i)


def draw(size=1024):
    S = 4  # draw big, shrink at the end for smooth rounded corners
    W = size * S
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    # Rainbow border: a rounded square filled with a left-to-right rainbow.
    grad = Image.new('RGBA', (W, W))
    gd = ImageDraw.Draw(grad)
    for x in range(W):
        gd.line([(x, 0), (x, W)], fill=rainbow_at(x / W) + (255,))
    m = int(W * 0.0625)
    mask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([m, m, W - m, W - m], radius=int(W * 0.19), fill=255)
    img.paste(grad, (0, 0), mask)
    # The dark tile, with a faint diagonal shade.
    inner = int(W * 0.094)
    tile = Image.new('RGBA', (W, W))
    td = ImageDraw.Draw(tile)
    for y in range(W):
        td.line([(0, y), (W, y)], fill=lerp((38, 26, 84), (22, 14, 50), y / W) + (255,))
    tmask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(tmask).rounded_rectangle([inner, inner, W - inner, W - inner], radius=int(W * 0.16), fill=255)
    img.paste(tile, (0, 0), tmask)
    # The sprite, centred, pixel-sharp.
    rows, cols = len(SPRITE), len(SPRITE[0])
    px = int(W * 0.68 / cols)
    ox, oy = (W - cols * px) // 2, (W - rows * px) // 2
    d = ImageDraw.Draw(img)
    for y, row in enumerate(SPRITE):
        for x, c in enumerate(row):
            if c in PAL:
                d.rectangle([ox + x * px, oy + y * px, ox + (x + 1) * px - 1, oy + (y + 1) * px - 1], fill=PAL[c] + (255,))
    return img.resize((size, size), Image.LANCZOS)


def hexc(c):
    return '#%02x%02x%02x' % c


def svg(tile=True, rows=None):
    """The same icon as an SVG (the phone's home-screen icon), or just the fish (tile=False, for small logos)."""
    rows = rows or SPRITE
    h, w = len(rows), len(rows[0])
    rects = ''.join(f'<rect x="{x}" y="{y}" width="1" height="1" fill="{hexc(PAL[c])}"/>' for y, row in enumerate(rows) for x, c in enumerate(row) if c in PAL)
    if not tile:
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" shape-rendering="crispEdges">{rects}</svg>'
    stops = ''.join(f'<stop offset="{i / (len(RAINBOW) - 1):.3f}" stop-color="{hexc(c)}"/>' for i, c in enumerate(RAINBOW))
    size = w + 8  # a 4-pixel margin around the sprite
    oy = (size - h) / 2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">'
            f'<defs><linearGradient id="rb">{stops}</linearGradient><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#261a54"/><stop offset="1" stop-color="#160e32"/></linearGradient></defs>'
            f'<rect width="{size}" height="{size}" rx="{size * 0.22:.2f}" fill="url(#rb)"/>'
            f'<rect x="{size * 0.04:.2f}" y="{size * 0.04:.2f}" width="{size * 0.92:.2f}" height="{size * 0.92:.2f}" rx="{size * 0.19:.2f}" fill="url(#bg)"/>'
            f'<g transform="translate(4 {oy})" shape-rendering="crispEdges">{rects}</g></svg>')


# Just the fish, for the small sidebar logo and the browser tab.
FISH = [r for r in SPRITE if any(c in 'KDMLC' for c in r)]

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'build/icon.png'
    draw().save(out)
    print('wrote', out)
    if len(sys.argv) == 1:
        open('ui/icon.svg', 'w').write(svg() + '\n')
        print('wrote ui/icon.svg')
