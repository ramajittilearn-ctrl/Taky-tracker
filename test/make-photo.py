#!/usr/bin/env python3
"""Generate a photo-like 4000x3000 JPEG (gradients + shapes + light noise) for the UI test."""
import random, sys
from PIL import Image, ImageDraw, ImageFilter
random.seed(7)
W, H = 4000, 3000
im = Image.new('RGB', (W, H))
d = ImageDraw.Draw(im)
for y in range(0, H, 4):
    d.rectangle([0, y, W, y + 4], fill=(90 + y * 90 // H, 140 + y * 60 // H, 200 - y * 120 // H))
for _ in range(60):
    x, y = random.randint(0, W), random.randint(0, H); r = random.randint(60, 400)
    d.ellipse([x - r, y - r, x + r, y + r], fill=(random.randint(80, 220), random.randint(80, 200), random.randint(60, 180)))
im = im.filter(ImageFilter.GaussianBlur(6))
noise = Image.effect_noise((W, H), 12).convert('RGB')
im = Image.blend(im, noise, 0.06)
im.save(sys.argv[1], 'JPEG', quality=92)
