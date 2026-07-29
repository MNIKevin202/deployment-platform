# Deployment Platform branding

`deployment-platform-logo-source.png` is the master art (a rounded-square
"DP" monogram mark, glowing blue-to-orange gradient, plus the "Deployment
Platform" wordmark, both designed on a dark backdrop) — never served
directly. `dp-icon-transparent-1024.png` is the icon cropped tight and
masked so everything outside the rounded-square shape is transparent (the
icon's own dark interior + glow is kept intact, since that's part of the
art, not a plain background to strip). This is what every favicon/app icon
in `../public/` is generated from, and what `Sidebar.tsx` / `AuthGate.tsx`
render directly as `/icon-192.png`.

Uses the same difference-of-gaussian-blur matte as Roadmap Studio's
branding pipeline (see `tools/roadmap-studio/branding/README.md` in the
Deployment Platform Installer repo for the full writeup and the gotcha
about cropping too tight before blurring).

## Regenerating the crop (only needed if the master art changes)

Requires numpy + Pillow (`pip3 install --user numpy pillow`).

```bash
cd apps/web/branding
python3 <<'EOF'
from PIL import Image, ImageFilter, ImageDraw
import numpy as np

im = Image.open("deployment-platform-logo-source.png").convert("RGB")
# Crop with generous margin around the mark, well clear of the wordmark to
# the right — check column coverage first if the source art changes size.
crop = im.crop((30, 100, 630, 750))
arr = np.array(crop).astype(np.float32)
bg_est = np.array(crop.filter(ImageFilter.GaussianBlur(45))).astype(np.float32)
diff3 = np.clip(arr - bg_est, 0, None)
alpha = np.clip(diff3.max(axis=2) / 30.0, 0, 1)
alpha_safe = np.clip(alpha, 0.10, 1.0)[..., None]
fg = np.clip(bg_est + diff3 / alpha_safe, 0, 255)
img = Image.fromarray(np.dstack([fg, alpha[..., None] * 255]).astype(np.uint8), "RGBA")

a = np.array(img)[:, :, 3]
ys, xs = np.where(a > 30)
x0, y0, x1, y1 = xs.min(), ys.min(), xs.max(), ys.max()
pad = 14
bx0, by0, bx1, by1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad

mask = Image.new("L", img.size, 0)
ImageDraw.Draw(mask).rounded_rectangle([bx0, by0, bx1, by1], radius=int((bx1 - bx0) * 0.20), fill=255)
mask = mask.filter(ImageFilter.GaussianBlur(6))

out = np.dstack([np.array(img)[:, :, :3], np.array(mask)]).astype(np.uint8)
Image.fromarray(out, "RGBA").crop((bx0 - 10, by0 - 10, bx1 + 10, by1 + 10)).save("dp-icon-transparent-1024.png")
EOF
```

## Regenerating the served sizes (Pillow, no extra dependency)

```bash
cd apps/web
python3 <<'EOF'
from PIL import Image
icon = Image.open("branding/dp-icon-transparent-1024.png").convert("RGBA")
for name, size in [("favicon-32.png", 32), ("favicon-16.png", 16), ("icon-192.png", 192), ("icon-512.png", 512)]:
    icon.resize((size, size), Image.LANCZOS).save(f"public/{name}")

# apple-touch-icon needs a SOLID background — iOS renders transparency as
# black. Fill with the app's own dark background color (--color-bg,
# #090c14), not a light neutral — iOS applies its own squircle mask on top
# of this square, so a light fill shows through as a visible ring around
# the art; a matching dark fill blends in.
dark_fill = Image.new("RGBA", icon.size, (9, 12, 20, 255))
dark_fill.alpha_composite(icon)
dark_fill.convert("RGB").resize((180, 180), Image.LANCZOS).save("public/apple-touch-icon.png")
EOF
```

Then rebuild (`npm run build` from `apps/web`) so the new sizes land in `dist/`.
