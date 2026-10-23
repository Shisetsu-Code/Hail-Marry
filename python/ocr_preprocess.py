"""Bounded full-image color contrasts for screenshot OCR; no game-specific crops."""

import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageChops

MAX_INPUT_PIXELS = 4_000_000
MAX_OUTPUT_PIXELS = 12_000_000


def preprocess(filename):
    source_path = Path(filename).resolve(strict=True)
    with Image.open(source_path) as opened:
        width, height = opened.size
        pixels = width * height
        if width <= 0 or height <= 0 or pixels > MAX_INPUT_PIXELS:
            raise ValueError("OCR preprocessing input exceeds the 4 megapixel limit")
        source = opened.convert("RGB")

    scale = min(3.0, math.sqrt(MAX_OUTPUT_PIXELS / pixels))
    output_width = max(1, math.floor(width * scale))
    output_height = max(1, math.floor(height * scale))
    variants = []
    # Signed opponent channels preserve colored lettering on decorative fills.
    # The threshold, scale and channel pairs are independent of the game/location.
    for name, first, second in (("rb", "R", "B"), ("gb", "G", "B")):
        contrast = ImageChops.subtract(source.getchannel(first), source.getchannel(second))
        mask = contrast.point(lambda value: 0 if value > 50 else 255)
        scaled = mask.resize((output_width, output_height), Image.Resampling.LANCZOS)
        destination = source_path.with_name(source_path.stem + ".ocr-" + name + ".png")
        scaled.save(destination, format="PNG")
        variants.append({
            "name": name,
            "path": str(destination),
            "scaleX": output_width / width,
            "scaleY": output_height / height,
        })
        scaled.close()
        mask.close()
        contrast.close()
    source.close()
    return {
        "status": "ok",
        "width": width,
        "height": height,
        "outputWidth": output_width,
        "outputHeight": output_height,
        "variants": variants,
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: ocr_preprocess.py SCREENSHOT.png")
    try:
        print(json.dumps(preprocess(sys.argv[1])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
