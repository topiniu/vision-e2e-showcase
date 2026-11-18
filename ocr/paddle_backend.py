#!/usr/bin/env python3
"""
Shared PaddleOCR helpers used by both the CLI and service entry-points.
"""
from __future__ import annotations

import base64
import io
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

import numpy as np
from paddleocr import PaddleOCR, __version__ as PADDLEOCR_VERSION  # type: ignore
from PIL import Image


@dataclass
class Roi:
  index: Optional[int]
  x: int
  y: int
  width: int
  height: int
  covers_full: bool


@dataclass
class Word:
  text: str
  confidence: float
  bbox: dict
  roi_index: Optional[int]


def clamp(value: float, min_value: float, max_value: float) -> float:
  return max(min_value, min(max_value, value))


def decode_data_url(data_url: str) -> bytes:
  match = re.match(r"data:(.*?);base64,(.*)$", data_url, re.IGNORECASE | re.DOTALL)
  if not match:
    raise ValueError("Invalid data URL payload.")
  return base64.b64decode(match.group(2))


def load_image(image_source) -> Image.Image:
  """
  Load an image into a RGB Pillow instance from a variety of sources:
  - pathlib.Path / str path
  - data URL str
  - bytes / bytearray
  - file-like object returning bytes
  """
  if isinstance(image_source, Image.Image):
    return image_source.convert("RGB")

  if isinstance(image_source, Path):
    return Image.open(image_source).convert("RGB")

  if isinstance(image_source, str):
    source = image_source.strip()
    if source.startswith("data:"):
      return load_image(decode_data_url(source))
    return Image.open(source).convert("RGB")

  if isinstance(image_source, (bytes, bytearray)):
    return Image.open(io.BytesIO(image_source)).convert("RGB")

  if hasattr(image_source, "read"):
    return Image.open(image_source).convert("RGB")

  raise TypeError(f"Unsupported image source type: {type(image_source)!r}")


def normalise_boxes(raw_result) -> List[dict]:
  """
  Convert PaddleOCR raw output into a list of {bbox, text, confidence}.
  """
  words = []
  if not raw_result:
    return words

  for region in raw_result:
    if not isinstance(region, Sequence):
      continue
    for entry in region:
      if not isinstance(entry, Sequence) or len(entry) != 2:
        continue
      quad, payload = entry
      if (
        not isinstance(quad, Sequence)
        or len(quad) != 4
        or not isinstance(payload, Sequence)
        or len(payload) != 2
      ):
        continue
      text, confidence = payload
      text = (text or "").strip()
      if not text:
        continue

      try:
        quad_points = [[float(pt[0]), float(pt[1])] for pt in quad]
      except (TypeError, ValueError):
        continue

      xs = [pt[0] for pt in quad_points]
      ys = [pt[1] for pt in quad_points]
      x0 = min(xs)
      y0 = min(ys)
      x1 = max(xs)
      y1 = max(ys)

      words.append(
        {
          "text": text,
          "confidence": float(confidence) if confidence is not None else 0.0,
          "bbox": {
            "x0": float(x0),
            "y0": float(y0),
            "x1": float(x1),
            "y1": float(y1),
            "width": float(x1 - x0),
            "height": float(y1 - y0),
            "quad": quad_points,
          },
        }
      )

  return words


def sanitise_rois(rois: Optional[Iterable[dict]], frame_width: int, frame_height: int) -> List[Roi]:
  if not rois:
    return [
      Roi(
        index=None,
        x=0,
        y=0,
        width=frame_width,
        height=frame_height,
        covers_full=True,
      )
    ]

  safe_width = max(frame_width, 1)
  safe_height = max(frame_height, 1)

  result: List[Roi] = []
  for idx, roi in enumerate(rois):
    if not isinstance(roi, dict):
      continue
    left = int(clamp(float(roi.get("x", 0)), 0, safe_width - 1))
    top = int(clamp(float(roi.get("y", 0)), 0, safe_height - 1))
    width = int(
      clamp(float(roi.get("width", safe_width)), 1, safe_width - left)
    )
    height = int(
      clamp(float(roi.get("height", safe_height)), 1, safe_height - top)
    )
    covers_full = (
      left == 0
      and top == 0
      and width == frame_width
      and height == frame_height
    )
    result.append(
      Roi(
        index=idx,
        x=left,
        y=top,
        width=width,
        height=height,
        covers_full=covers_full,
      )
    )

  if not result:
    result.append(
      Roi(
        index=None,
        x=0,
        y=0,
        width=frame_width,
        height=frame_height,
        covers_full=True,
      )
    )
  return result


def shift_word(word: dict, offset_x: int, offset_y: int) -> dict:
  bbox = word.get("bbox") or {}
  quad = bbox.get("quad") or []
  shifted_quad = [[pt[0] + offset_x, pt[1] + offset_y] for pt in quad]
  shifted = {
    "text": word.get("text", ""),
    "confidence": float(word.get("confidence", 0.0)),
    "bbox": {
      "x0": float(bbox.get("x0", 0.0) + offset_x),
      "y0": float(bbox.get("y0", 0.0) + offset_y),
      "x1": float(bbox.get("x1", 0.0) + offset_x),
      "y1": float(bbox.get("y1", 0.0) + offset_y),
      "width": float(bbox.get("width", 0.0)),
      "height": float(bbox.get("height", 0.0)),
      "quad": shifted_quad,
    },
  }
  return shifted


def run_paddle_ocr(
  ocr: PaddleOCR,
  image: Image.Image,
  rois: Optional[Iterable[dict]] = None,
  *,
  use_angle_cls: bool = True,
) -> Tuple[List[Word], dict]:
  """
  Execute PaddleOCR across provided ROIs and return word entries.
  """
  width, height = image.size
  normalised_rois = sanitise_rois(rois, width, height)
  aggregated: List[Word] = []

  full_image_array = None
  start = time.perf_counter()

  for roi in normalised_rois:
    if roi.covers_full:
      if full_image_array is None:
        full_image_array = np.ascontiguousarray(np.array(image))
      raw_result = ocr.ocr(full_image_array, cls=use_angle_cls)
      offset_x = 0
      offset_y = 0
    else:
      crop = image.crop((roi.x, roi.y, roi.x + roi.width, roi.y + roi.height))
      crop_array = np.ascontiguousarray(np.array(crop))
      raw_result = ocr.ocr(crop_array, cls=use_angle_cls)
      offset_x = roi.x
      offset_y = roi.y

    words = normalise_boxes(raw_result)
    for word in words:
      shifted = shift_word(word, offset_x, offset_y)
      aggregated.append(
        Word(
          text=shifted["text"],
          confidence=float(shifted["confidence"]),
          bbox=shifted["bbox"],
          roi_index=roi.index,
        )
      )

  runtime_ms = (time.perf_counter() - start) * 1000.0
  aggregated.sort(key=lambda w: w.confidence, reverse=True)
  meta = {
    "runtime_ms": runtime_ms,
    "image_width": width,
    "image_height": height,
    "roi_count": len(normalised_rois),
    "paddleocr_version": PADDLEOCR_VERSION,
  }
  return aggregated, meta


def compute_scale_factors(frame_size: Optional[dict], image_width: int, image_height: int) -> Tuple[float, float, float, float]:
  dip_width = float(frame_size.get("dipWidth") or frame_size.get("dip_width") or image_width) if frame_size else float(image_width)
  dip_height = float(frame_size.get("dipHeight") or frame_size.get("dip_height") or image_height) if frame_size else float(image_height)
  dpr = frame_size.get("dpr") if isinstance(frame_size, dict) else None

  dpr_x = None
  dpr_y = None
  if isinstance(dpr, dict):
    dpr_x = dpr.get("x") or dpr.get("horizontal")
    dpr_y = dpr.get("y") or dpr.get("vertical")

  width = float(frame_size.get("width") or image_width) if isinstance(frame_size, dict) else float(image_width)
  height = float(frame_size.get("height") or image_height) if isinstance(frame_size, dict) else float(image_height)

  px_to_dip_x = 1.0 / dpr_x if dpr_x and float(dpr_x) > 0 else (dip_width / width if width > 0 else 1.0)
  px_to_dip_y = 1.0 / dpr_y if dpr_y and float(dpr_y) > 0 else (dip_height / height if height > 0 else 1.0)

  return float(px_to_dip_x), float(px_to_dip_y), float(dip_width), float(dip_height)


def word_to_detection(
  word: Word,
  *,
  frame_id,
  frame_ts: float,
  frame_size: Optional[dict],
  image_width: int,
  image_height: int,
) -> dict:
  bbox = word.bbox
  x0 = float(bbox.get("x0", 0.0))
  y0 = float(bbox.get("y0", 0.0))
  x1 = float(bbox.get("x1", x0))
  y1 = float(bbox.get("y1", y0))

  px_width = max(0.0, x1 - x0)
  px_height = max(0.0, y1 - y0)

  if px_width <= 0 or px_height <= 0:
    return {}

  px_to_dip_x, px_to_dip_y, dip_width, dip_height = compute_scale_factors(
    frame_size, image_width, image_height
  )

  dip_x = clamp(x0 * px_to_dip_x, 0.0, dip_width)
  dip_y = clamp(y0 * px_to_dip_y, 0.0, dip_height)
  dip_width_box = clamp(px_width * px_to_dip_x, 0.0, dip_width - dip_x)
  dip_height_box = clamp(px_height * px_to_dip_y, 0.0, dip_height - dip_y)

  if dip_width_box <= 0 or dip_height_box <= 0:
    return {}

  detection = {
    "kind": "text",
    "bbox": {
      "x": dip_x,
      "y": dip_y,
      "width": dip_width_box,
      "height": dip_height_box,
    },
    "text": word.text,
    "score": clamp(word.confidence, 0.0, 1.0),
    "frameId": frame_id,
    "ts": frame_ts,
    "extras": {
      "roiIndex": word.roi_index,
      "confidence": word.confidence,
      "bboxPx": {
        "x": x0,
        "y": y0,
        "width": px_width,
        "height": px_height,
      },
      "source": "paddleocr",
      "paddleocrVersion": PADDLEOCR_VERSION,
    },
  }
  return detection


__all__ = [
  "PADDLEOCR_VERSION",
  "load_image",
  "run_paddle_ocr",
  "word_to_detection",
  "compute_scale_factors",
  "sanitise_rois",
  "normalise_boxes",
]
