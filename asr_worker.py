# -*- coding: utf-8 -*-
# 常驻的语音转写进程：模型只加载一次，之后按行收任务
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

os.environ.setdefault("HF_HOME", r"C:\Users\Administrator\.dsh\bili-duty\.hf-cache")

from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHALE_ASR_MODEL", "small")
model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=4)
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        job = json.loads(line)
        path = job["path"]
        segments, info = model.transcribe(path, language="zh", vad_filter=True, beam_size=1)
        text = "".join(seg.text for seg in segments).strip()
        print(json.dumps({"id": job.get("id"), "text": text}, ensure_ascii=False), flush=True)
    except Exception as e:
        print(json.dumps({"id": job.get("id") if isinstance(job, dict) else None, "error": str(e)}, ensure_ascii=False), flush=True)
