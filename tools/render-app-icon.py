#!/usr/bin/env python3
"""Render the canonical SVG design into a multi-resolution Windows ICO."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "icon" / "app.ico"
SCALE = 4
BASE = 256 * SCALE


def point(x: float, y: float) -> tuple[int, int]:
    return round(x * SCALE), round(y * SCALE)


def box(x: float, y: float, width: float, height: float) -> tuple[int, int, int, int]:
    left, top = point(x, y)
    right, bottom = point(x + width, y + height)
    return left, top, right, bottom


def stroke(value: float) -> int:
    return round(value * SCALE)


def main() -> None:
    image = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    blue = "#A9C6EA"
    pink = "#F6B9D3"
    ink = "#3A3044"

    draw.rounded_rectangle(box(22, 22, 212, 212), radius=stroke(50), fill=blue)
    draw.rounded_rectangle(
        box(60, 52, 140, 70), radius=stroke(22), fill=blue, outline=ink, width=stroke(8)
    )
    draw.ellipse(box(81, 79, 10, 10), fill=ink)
    draw.line([point(106, 84), point(158, 84)], fill=ink, width=stroke(8))
    draw.rounded_rectangle(
        box(44, 116, 168, 84), radius=stroke(24), fill=pink, outline=ink, width=stroke(8)
    )
    path = [point(78, 140), point(96, 156), point(78, 172)]
    draw.line(path, fill=ink, width=stroke(8), joint="curve")
    draw.line([point(114, 172), point(146, 172)], fill=ink, width=stroke(8))
    draw.ellipse(box(74, 136, 8, 8), fill=ink)
    draw.ellipse(box(74, 168, 8, 8), fill=ink)
    draw.ellipse(box(110, 168, 8, 8), fill=ink)
    draw.ellipse(box(142, 168, 8, 8), fill=ink)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(
        OUTPUT,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"wrote {OUTPUT}")


if __name__ == "__main__":
    main()
