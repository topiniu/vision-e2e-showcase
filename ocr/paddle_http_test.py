#!/usr/bin/env python3
"""
Send a single image to the local PaddleOCR service for manual verification.

Usage:
    python ocr/paddle_http_test.py static/test.jpg \
        --endpoint http://127.0.0.1:32145 \
        --frame-id 123 \
        --timeout 2000
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path
from typing import List, Tuple
from urllib import request as urlrequest


def encode_image_to_data_url(image_path: Path) -> str:
    mime = "image/png"
    suffix = image_path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        mime = "image/jpeg"
    elif suffix in {".bmp"}:
        mime = "image/bmp"
    data = image_path.read_bytes()
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def parse_roi(raw: str) -> Tuple[int, int, int, int]:
    try:
        parts = [int(float(p.strip())) for p in raw.split(",")]
    except ValueError as exc:  # pragma: no cover
        raise argparse.ArgumentTypeError(f"Invalid ROI '{raw}': {exc}") from exc
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(f"ROI '{raw}' must have four comma-separated numbers (x,y,width,height).")
    x, y, w, h = parts
    if w <= 0 or h <= 0:
        raise argparse.ArgumentTypeError(f"ROI '{raw}' width/height must be positive.")
    return x, y, w, h


def build_payload(args: argparse.Namespace) -> dict:
    image_url = encode_image_to_data_url(args.image)
    rois = [dict(x=x, y=y, width=w, height=h) for x, y, w, h in args.roi]
    payload = {
        "frameId": args.frame_id,
        "ts": args.timestamp or None,
        "image": {"dataUrl": image_url},
        "rois": rois,
        "frameSize": {
            "width": args.frame_width,
            "height": args.frame_height,
            "dipWidth": args.frame_width,
            "dipHeight": args.frame_height,
        },
        "timeoutMs": args.timeout,
        "options": {
            "lang": args.lang,
            "disableAngleCls": args.disable_angle_cls,
            "enableMp": args.enable_mp,
            "minScore": args.min_score,
        },
        "source": args.source,
    }
    if not payload["options"]["minScore"]:
        payload["options"]["minScore"] = None
    return payload


def post_json(endpoint: str, payload: dict, timeout_ms: int) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urlrequest.Request(
        url=f"{endpoint.rstrip('/')}/ocr",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    timeout_sec = max(timeout_ms / 1000.0, 1.0)
    with urlrequest.urlopen(req, timeout=timeout_sec) as resp:
        raw = resp.read()
        return json.loads(raw.decode("utf-8"))


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send a test image to the PaddleOCR HTTP service.")
    parser.add_argument("image", type=Path, help="Path to an image file (png/jpg).")
    parser.add_argument("--endpoint", default="http://127.0.0.1:32145", help="Service base URL.")
    parser.add_argument("--frame-id", type=int, default=1, help="Frame identifier to send with the request.")
    parser.add_argument("--frame-width", type=int, default=1920, help="Frame width in pixels (metadata).")
    parser.add_argument("--frame-height", type=int, default=1080, help="Frame height in pixels (metadata).")
    parser.add_argument("--roi", type=parse_roi, action="append", default=[], help="ROI as x,y,width,height (can repeat).")
    parser.add_argument("--timeout", type=int, default=1500, help="Timeout for the HTTP call in milliseconds.")
    parser.add_argument("--timestamp", type=float, help="Optional timestamp (ms) for the frame.")
    parser.add_argument("--lang", default="ch", help="Language pack (default 'ch').")
    parser.add_argument("--disable-angle-cls", action="store_true", help="Disable angle classifier.")
    parser.add_argument("--enable-mp", action="store_true", help="Enable Paddle multiprocessing.")
    parser.add_argument("--min-score", type=float, help="Minimum confidence filter (0-1).")
    parser.add_argument("--source", default="smoke-test", help="Source tag stored in detection extras.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    return parser.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    image_path = args.image.expanduser().resolve()
    if not image_path.exists():
        print(f"Image not found: {image_path}", file=sys.stderr)
        return 1

    payload = build_payload(args)
    try:
        response = post_json(args.endpoint, payload, args.timeout)
    except Exception as exc:  # pragma: no cover
        print(f"Request failed: {exc}", file=sys.stderr)
        return 2

    json_dump = json.dumps(response, indent=2 if args.pretty else None, ensure_ascii=False)
    print(json_dump)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
