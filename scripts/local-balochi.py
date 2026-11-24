#!/usr/bin/env python3
"""Offline, on-demand Balochi ASR/TTS helper. Requires locally cached models.

Usage:
  python scripts/local-balochi.py stt input.wav transcript.txt MODEL_DIR
  python scripts/local-balochi.py tts answer.txt reply.wav MODEL_DIR

The models are explicitly downloaded by setup-local-voice.sh --balochi.
No Hugging Face network calls occur during inference.
"""
import os
import sys
import wave
from pathlib import Path


def write_wav(path, signal, sample_rate):
    import numpy as np

    samples = np.clip(signal, -1.0, 1.0)
    pcm = (samples * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(int(sample_rate))
        out.writeframes(pcm.tobytes())


def main():
    if len(sys.argv) != 5 or sys.argv[1] not in ("stt", "tts"):
        raise SystemExit("Expected stt or tts with input, output, model directory")
    mode, source, target, model_dir = sys.argv[1:]
    if not Path(model_dir).is_dir():
        raise SystemExit("Balochi model has not been installed")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

    import numpy as np
    import torch
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    if mode == "stt":
        from transformers import WhisperProcessor, WhisperForConditionalGeneration

        processor = WhisperProcessor.from_pretrained(model_dir, local_files_only=True)
        model = WhisperForConditionalGeneration.from_pretrained(
            model_dir, local_files_only=True
        ).cpu().eval()
        with wave.open(source, "rb") as wf:
            if wf.getframerate() != 16000 or wf.getnchannels() != 1 or wf.getsampwidth() != 2:
                raise ValueError("Expected 16kHz mono PCM16 input")
            samples = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
        features = processor(samples.astype(np.float32) / 32768.0,
                             sampling_rate=16000, return_tensors="pt").input_features
        with torch.inference_mode():
            tokens = model.generate(features, max_new_tokens=120)
        transcript = processor.batch_decode(tokens, skip_special_tokens=True)[0].strip()
        Path(target).write_text(transcript, encoding="utf-8")
    else:
        from transformers import VitsModel, AutoTokenizer

        text = Path(source).read_text(encoding="utf-8").strip()
        if not text:
            raise ValueError("Empty TTS input")
        tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
        model = VitsModel.from_pretrained(model_dir, local_files_only=True).cpu().eval()
        inputs = tokenizer(text[:240], return_tensors="pt")
        with torch.inference_mode():
            speech = model(**inputs).waveform.squeeze().cpu().numpy()
        write_wav(target, speech, model.config.sampling_rate)


if __name__ == "__main__":
    main()
