#!/usr/bin/env python3
"""
FastAPI microservice exposing PaddleOCR through the BV-4.0 perception contract.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, validator

try:
    from paddleocr import PaddleOCR  # type: ignore
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "PaddleOCR is not installed. Install with:\n"
        "  pip install paddlepaddle==2.6.1 paddleocr==2.7.3 pillow fastapi uvicorn[standard]\n"
        f"Original import error: {exc}"
    ) from exc

from paddle_backend import (
    PADDLEOCR_VERSION,
    load_image,
    run_paddle_ocr,
    word_to_detection,
)

SERVICE_VERSION = "0.1.0"
DEFAULT_LANG = os.getenv("PPOCR_LANG", "ch")
USE_ANGLE_CLS = os.getenv("PPOCR_DISABLE_CLS", "0") not in ("1", "true", "TRUE")
USE_MP = os.getenv("PPOCR_USE_MP", "0") in ("1", "true", "TRUE")
MIN_SCORE_DEFAULT = float(os.getenv("PPOCR_MIN_SCORE", "0"))
DEFAULT_REQUEST_TIMEOUT_MS = 1500


class RoiPayload(BaseModel):
    x: float
    y: float
    width: float
    height: float


class DprPayload(BaseModel):
    x: Optional[float] = None
    y: Optional[float] = None


class FrameSizePayload(BaseModel):
    width: Optional[float] = None
    height: Optional[float] = None
    dipWidth: Optional[float] = Field(None, alias="dipWidth")
    dipHeight: Optional[float] = Field(None, alias="dipHeight")
    dpr: Optional[DprPayload] = None

    class Config:
        allow_population_by_field_name = True


class ImagePayload(BaseModel):
    dataUrl: Optional[str] = Field(None, alias="dataUrl")
    bytesBase64: Optional[str] = Field(None, alias="bytesBase64")
    path: Optional[str] = None

    class Config:
        allow_population_by_field_name = True

    @validator("dataUrl", "bytesBase64", pre=True)
    def strip_whitespace(cls, value):
        if isinstance(value, str):
            return value.strip()
        return value

    def to_image(self):
        if self.dataUrl:
            return load_image(self.dataUrl)
        if self.bytesBase64:
            return load_image(base64.b64decode(self.bytesBase64))
        if self.path:
            return load_image(Path(self.path).expanduser())
        raise ValueError("No image payload provided.")


class RequestOptions(BaseModel):
    lang: Optional[str] = None
    disableAngleCls: Optional[bool] = Field(None, alias="disableAngleCls")
    enableMp: Optional[bool] = Field(None, alias="enableMp")
    minScore: Optional[float] = Field(None, alias="minScore")

    class Config:
        allow_population_by_field_name = True


class OcrRequest(BaseModel):
    frameId: Any = Field(..., alias="frameId")
    ts: Optional[float] = None
    image: ImagePayload
    rois: List[RoiPayload] = Field(default_factory=list)
    frameSize: Optional[FrameSizePayload] = Field(None, alias="frameSize")
    timeoutMs: Optional[int] = Field(None, alias="timeoutMs")
    options: Optional[RequestOptions] = None
    source: Optional[str] = None

    class Config:
        allow_population_by_field_name = True


class ErrorInfo(BaseModel):
    code: str
    message: str


class OcrResponse(BaseModel):
    frameId: Any
    ts: float
    elapsedMs: float
    timedOut: bool
    status: str
    detections: List[Dict[str, Any]]
    queueDepth: int
    error: Optional[ErrorInfo] = None
    service: Dict[str, Any]


class ServiceState:
    def __init__(self):
        self.ocr: Optional[PaddleOCR] = None
        self.inflight: int = 0
        self.total_requests: int = 0
        self.timeouts: int = 0
        self.failures: int = 0
        self.lock = asyncio.Lock()
        self.inference_lock = asyncio.Lock()
        self.logger = logging.getLogger("paddle_service")


state = ServiceState()
app = FastAPI(title="PaddleOCR Service", version=SERVICE_VERSION)


async def ensure_ocr(options: Optional[RequestOptions]) -> PaddleOCR:
    if state.ocr:
        return state.ocr

    async with state.lock:
        if state.ocr:
            return state.ocr

        lang = options.lang if options and options.lang else DEFAULT_LANG
        use_angle_cls = (
            not options.disableAngleCls
            if options and options.disableAngleCls is not None
            else USE_ANGLE_CLS
        )
        use_mp = (
            options.enableMp
            if options and options.enableMp is not None
            else USE_MP
        )

        state.logger.info(
            "Loading PaddleOCR (lang=%s, angle_cls=%s, mp=%s)",
            lang,
            use_angle_cls,
            use_mp,
        )
        ocr = await asyncio.to_thread(
            PaddleOCR,
            use_angle_cls=use_angle_cls,
            lang=lang,
            show_log=False,
            use_mp=use_mp,
        )
        state.ocr = ocr
        state.logger.info("PaddleOCR loaded: version=%s", PADDLEOCR_VERSION)
        return ocr


def build_service_meta() -> Dict[str, Any]:
    return {
        "serviceVersion": SERVICE_VERSION,
        "paddleocrVersion": PADDLEOCR_VERSION,
        "backend": "paddle",
        "inflight": state.inflight,
        "total": state.total_requests,
        "timeouts": state.timeouts,
        "failures": state.failures,
    }


async def perform_inference(req: OcrRequest) -> Dict[str, Any]:
    opts = req.options or RequestOptions()
    ocr = await ensure_ocr(opts)
    image = req.image.to_image()
    rois = [roi.dict() for roi in req.rois]
    use_angle_cls = not opts.disableAngleCls if opts.disableAngleCls is not None else USE_ANGLE_CLS
    async with state.inference_lock:
        words, meta = await asyncio.to_thread(
            run_paddle_ocr,
            ocr,
            image,
            rois,
            use_angle_cls=use_angle_cls,
        )

    frame_ts = req.ts if req.ts is not None else time.time() * 1000.0
    min_score = opts.minScore if opts.minScore is not None else MIN_SCORE_DEFAULT
    detections: List[Dict[str, Any]] = []
    for word in words:
        if min_score and word.confidence < min_score:
            continue
        detection = word_to_detection(
            word,
            frame_id=req.frameId,
            frame_ts=frame_ts,
            frame_size=req.frameSize.dict(by_alias=True) if req.frameSize else None,
            image_width=image.width,
            image_height=image.height,
        )
        if detection:
            if req.source:
                detection.setdefault("extras", {})
                detection["extras"]["source"] = req.source
            detections.append(detection)

    elapsed_ms = float(meta.get("runtime_ms", 0.0))
    status = "ok"
    if not detections:
        status = "empty"

    return {
        "frameId": req.frameId,
        "ts": frame_ts,
        "elapsedMs": elapsed_ms,
        "timedOut": False,
        "status": status,
        "detections": detections,
    }


@app.post("/ocr", response_model=OcrResponse)
async def ocr_endpoint(request: OcrRequest):
    opts = request.options or RequestOptions()
    use_angle_cls_flag = (
        not opts.disableAngleCls if opts.disableAngleCls is not None else USE_ANGLE_CLS
    )
    timeout_ms = request.timeoutMs or DEFAULT_REQUEST_TIMEOUT_MS
    state.logger.info(
        "OCR request start frameId=%s rois=%d timeoutMs=%s lang=%s angle_cls=%s",
        request.frameId,
        len(request.rois),
        timeout_ms,
        opts.lang or DEFAULT_LANG,
        use_angle_cls_flag,
    )
    state.total_requests += 1
    queue_depth = state.inflight
    state.inflight += 1
    timeout_seconds = timeout_ms / 1000.0 if timeout_ms else None

    try:
        if timeout_seconds:
            try:
                response = await asyncio.wait_for(
                    perform_inference(request),
                    timeout=timeout_seconds,
                )
            except asyncio.TimeoutError:
                state.timeouts += 1
                state.logger.warning(
                    "OCR request timeout frameId=%s timeoutMs=%s",
                    request.frameId,
                    timeout_ms,
                )
                return OcrResponse(
                    frameId=request.frameId,
                    ts=request.ts if request.ts is not None else time.time() * 1000.0,
                    elapsedMs=timeout_ms,
                    timedOut=True,
                    status="timeout",
                    detections=[],
                    queueDepth=max(queue_depth, 0),
                    error=ErrorInfo(
                        code="timeout",
                        message=f"Inference exceeded timeout {timeout_ms} ms",
                    ),
                    service=build_service_meta(),
                )
        else:
            response = await perform_inference(request)
        response["queueDepth"] = max(queue_depth, 0)
        response["service"] = build_service_meta()
        state.logger.info(
            "OCR request done frameId=%s status=%s detections=%d elapsed=%.1fms",
            request.frameId,
            response.get("status"),
            len(response.get("detections", [])),
            response.get("elapsedMs") or -1,
        )
        return OcrResponse(**response)
    except Exception as exc:
        state.failures += 1
        state.logger.exception("OCR inference failed: frameId=%s", request.frameId)
        raise HTTPException(
            status_code=500,
            detail={
                "code": "inference_error",
                "message": str(exc),
            },
        ) from exc
    finally:
        state.inflight = max(state.inflight - 1, 0)


@app.get("/healthz")
async def healthz():
    return {
        "ok": True,
        "serviceVersion": SERVICE_VERSION,
        "paddleocrVersion": PADDLEOCR_VERSION,
        "loaded": bool(state.ocr),
        "inflight": state.inflight,
        "total": state.total_requests,
        "timeouts": state.timeouts,
        "failures": state.failures,
    }


def main():
    import uvicorn

    host = os.getenv("PPOCR_HOST", "127.0.0.1")
    port = int(os.getenv("PPOCR_PORT", "32145"))
    log_level = os.getenv("PPOCR_LOG_LEVEL", "info")
    uvicorn.run(
        "paddle_service:app",
        host=host,
        port=port,
        log_level=log_level,
        reload=False,
    )


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    main()
