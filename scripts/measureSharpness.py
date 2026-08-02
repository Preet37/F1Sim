#!/usr/bin/env python3
"""
Measures how much real detail is in an image, so "grainy and unclear" stops
being a matter of opinion.

WHY THESE TWO NUMBERS

  hf   Fraction of the image's total spatial-frequency energy that sits above
       half of Nyquist. An image rendered at half resolution and scaled up has
       almost nothing there — the upscaler cannot invent it — so this is the
       number that separates "soft because it was rendered small" from
       "soft because it was blurred".

  grad Mean Sobel gradient magnitude, normalised by the image's own standard
       deviation so a dark night shot is not penalised against a bright day
       one. This is closer to what the eye calls edge definition.

Both are computed on a central crop, on luma, with a Hann window before the
FFT (without one, the frame edges contribute a cross of false high frequency
that swamps everything else). Images are resampled to a common height first,
because a 1280-wide reference and a 2940-wide screenshot are not otherwise
comparable — frequency is per pixel, and pixels are not the same size.

Usage:
  python3 scripts/measureSharpness.py <image-or-dir> [more...]
  python3 scripts/measureSharpness.py --height 720 sharp-out/before
"""

import sys
import os
import glob
import numpy as np
from PIL import Image

COMMON_HEIGHT = 720
CROP = 0.6  # central fraction, in each axis


def luma(path, height):
    im = Image.open(path).convert('RGB')
    if im.height != height:
        w = int(round(im.width * height / im.height))
        im = im.resize((w, height), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float64) / 255.0
    # Rec.709 luma on the encoded (display-referred) values, which is what the
    # eye is looking at.
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def centre_crop(a, frac):
    h, w = a.shape
    ch, cw = int(h * frac), int(w * frac)
    y, x = (h - ch) // 2, (w - cw) // 2
    return a[y:y + ch, x:x + cw]


def hf_fraction(a, cutoff=0.5):
    """Energy above `cutoff` x Nyquist, as a fraction of the total."""
    h, w = a.shape
    win = np.outer(np.hanning(h), np.hanning(w))
    f = np.fft.fftshift(np.fft.fft2((a - a.mean()) * win))
    p = np.abs(f) ** 2
    fy = np.fft.fftshift(np.fft.fftfreq(h))[:, None] * 2  # -1..1 in Nyquist
    fx = np.fft.fftshift(np.fft.fftfreq(w))[None, :] * 2
    r = np.sqrt(fy ** 2 + fx ** 2)
    total = p.sum()
    return float(p[r > cutoff].sum() / total) if total > 0 else 0.0


def grad_mag(a):
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float64)
    ky = kx.T
    def conv(img, k):
        out = np.zeros_like(img)
        for dy in range(3):
            for dx in range(3):
                out[1:-1, 1:-1] += k[dy, dx] * img[dy:dy + img.shape[0] - 2,
                                                   dx:dx + img.shape[1] - 2]
        return out[1:-1, 1:-1]
    gx, gy = conv(a, kx), conv(a, ky)
    g = np.sqrt(gx ** 2 + gy ** 2)
    sd = a.std()
    return float(g.mean() / sd) if sd > 1e-6 else 0.0


def measure(path, height):
    a = centre_crop(luma(path, height), CROP)
    return hf_fraction(a), grad_mag(a)


def expand(args):
    out = []
    for a in args:
        if os.path.isdir(a):
            for e in ('png', 'jpg', 'jpeg'):
                out += sorted(glob.glob(os.path.join(a, '*.' + e)))
        else:
            out += sorted(glob.glob(a))
    return out


def main():
    args = sys.argv[1:]
    height = COMMON_HEIGHT
    if args and args[0] == '--height':
        height = int(args[1])
        args = args[2:]
    files = expand(args)
    if not files:
        print('no images')
        return
    print(f'resampled to {height}px tall, centre {int(CROP*100)}% crop\n')
    print(f'{"image":54} {"hf":>8} {"grad":>8}')
    rows = []
    for f in files:
        try:
            hf, g = measure(f, height)
        except Exception as e:  # noqa: BLE001
            print(f'{os.path.basename(f):54} ERROR {e}')
            continue
        rows.append((f, hf, g))
        print(f'{os.path.relpath(f):54} {hf:8.4f} {g:8.4f}')
    if len(rows) > 1:
        hs = np.array([r[1] for r in rows])
        gs = np.array([r[2] for r in rows])
        print(f'\n{"MEDIAN":54} {np.median(hs):8.4f} {np.median(gs):8.4f}')


if __name__ == '__main__':
    main()
