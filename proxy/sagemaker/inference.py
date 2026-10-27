"""Reference SageMaker inference handler for Skill Recorder speech-to-text.

Runs Whisper with the Hugging Face `transformers` pipeline inside a Hugging Face
PyTorch inference container. It implements the request/response contract the
Skill Recorder service sends (see README.md):

  request  application/json  {"audio": "<base64 16 kHz mono 16-bit WAV>", "language": "de"}
           or audio/wav      raw WAV bytes (language from CustomAttributes "language=de")
  response application/json  {"text": "...", "chunks": [{"timestamp": [start, end], "text": "..."}]}

Set WHISPER_MODEL_ID to choose the checkpoint (default openai/whisper-large-v3).
"""

import base64
import io
import json
import os
import wave

import numpy as np

MODEL_ID = os.environ.get("WHISPER_MODEL_ID", "openai/whisper-large-v3")
CUSTOM_ATTRIBUTES_HEADER = "X-Amzn-SageMaker-Custom-Attributes"


def model_fn(model_dir, context=None):
    import torch
    from transformers import pipeline

    cuda = torch.cuda.is_available()
    # Prefer weights packaged with the model; otherwise download WHISPER_MODEL_ID.
    source = model_dir if os.path.exists(os.path.join(model_dir, "config.json")) else MODEL_ID
    return pipeline(
        "automatic-speech-recognition",
        model=source,
        device=0 if cuda else -1,
        torch_dtype=torch.float16 if cuda else torch.float32,
    )


def input_fn(input_data, content_type, context=None):
    content_type = (content_type or "").split(";")[0].strip().lower()
    if content_type == "application/json":
        body = json.loads(input_data)
        audio = base64.b64decode(body["audio"])
        language = body.get("language") or None
    elif content_type in ("audio/wav", "audio/x-wav", "audio/wave"):
        audio = bytes(input_data)
        language = language_from_custom_attributes(context)
    else:
        raise ValueError(f"Unsupported content type: {content_type}")
    return {"audio": decode_wav(audio), "language": language}


def language_from_custom_attributes(context):
    """Best effort: read `language=xx` from the CustomAttributes header."""
    try:
        header = context.get_request_header(0, CUSTOM_ATTRIBUTES_HEADER) or ""
    except Exception:
        return None
    for part in header.split(";"):
        key, _, value = part.strip().partition("=")
        if key == "language" and value:
            return value
    return None


def decode_wav(data):
    with wave.open(io.BytesIO(data), "rb") as wav:
        if wav.getsampwidth() != 2:
            raise ValueError("Expected 16-bit PCM WAV audio.")
        frames = wav.readframes(wav.getnframes())
        rate = wav.getframerate()
        channels = wav.getnchannels()
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return {"raw": samples, "sampling_rate": rate}


def predict_fn(data, pipe, context=None):
    generate_kwargs = {"task": "transcribe"}
    if data["language"]:
        generate_kwargs["language"] = data["language"]
    result = pipe(
        dict(data["audio"]),
        return_timestamps=True,
        chunk_length_s=30,
        generate_kwargs=generate_kwargs,
    )
    return {
        "text": result.get("text", ""),
        "chunks": [
            {"timestamp": list(chunk["timestamp"]), "text": chunk["text"]}
            for chunk in result.get("chunks", [])
        ],
    }


def output_fn(prediction, accept, context=None):
    return json.dumps(prediction)
