#!/usr/bin/env python3
"""
CLI helper to run PaddleOCR on a single image and dump detections as JSON.

Example:
    python ocr/paddle_cli.py tests/sample.png --lang ch
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

try:
    from paddleocr import PaddleOCR
except ImportError as exc:  # pragma: no cover
    msg = (
        "PaddleOCR is not installed. Install with:\n"
        "  pip install paddlepaddle==2.6.1 paddleocr==2.7.3 pillow\n"
        "Original import error: "
    )
    print(msg + str(exc), file=sys.stderr)
    sys.exit(2)

from paddle_backend import (
    PADDLEOCR_VERSION,
    load_image,
    run_paddle_ocr,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run PaddleOCR on an image and emit word boxes as JSON.",
    )
    parser.add_argument(
        "image",
        type=Path,
        help="Path to the image to analyse.",
    )
    parser.add_argument(
        "--lang",
        default="ch",
        help="Language pack to load (default: ch for Chinese + English).",
    )
    parser.add_argument(
        "--disable-angle-cls",
        action="store_true",
        help="Disable angle classification (rotate corrections).",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output for readability.",
    )
    parser.add_argument(
        "--enable-mp",
        action="store_true",
        help="Keep PaddleOCR multiprocessing on (default off for compatibility).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional path to write JSON output instead of stdout.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    image_path = args.image.expanduser().resolve()
    if not image_path.exists():
        print(f"Image not found: {image_path}", file=sys.stderr)
        return 1

    sys.stderr.write(
        "Initialising PaddleOCR (first run may download ~200 MB of models)…\n"
    )
    sys.stderr.flush()

    # Create OCR instance
    ocr = PaddleOCR(
        use_angle_cls=not args.disable_angle_cls,
        lang=args.lang,
        show_log=False,
        use_mp=args.enable_mp,
    )

    sys.stderr.write("Model ready. Running OCR inference…\n")
    sys.stderr.flush()

    image = load_image(image_path)
    words, meta = run_paddle_ocr(
        ocr,
        image,
        rois=None,
        use_angle_cls=not args.disable_angle_cls,
    )

    payload = {
        "image": str(image_path),
        "runtime_ms": meta["runtime_ms"],
        "paddleocr_version": PADDLEOCR_VERSION,
        "words": [
            {
                "bbox": word.bbox,
                "text": word.text,
                "confidence": word.confidence,
                "roiIndex": word.roi_index,
            }
            for word in words
        ],
    }

    json_dump = json.dumps(payload, indent=2 if args.pretty else None, ensure_ascii=False)

    if args.output:
        args.output.write_text(json_dump + ("\n" if args.pretty else ""), encoding="utf-8")
    else:
        print(json_dump)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
