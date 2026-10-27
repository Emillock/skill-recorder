# Speech-to-text endpoint

Skill Recorder transcribes voice narration on a SageMaker endpoint when the AWS
backend is selected. The desktop app cuts narration into clips of at most a
minute (16 kHz mono 16-bit WAV, cut at pauses) and sends each one to the
service's `/v1/transcribe` route, which calls the endpoint named by the stack's
`AsrEndpointName` parameter.

## Contract

The service calls `InvokeEndpoint` with `Accept: application/json` and one of
two request formats, chosen by the `AsrRequestFormat` stack parameter:

| Format | `ContentType` | Body |
|---|---|---|
| `json` (default) | `application/json` | `{"audio": "<base64 WAV>", "language": "de", "return_timestamps": true}` |
| `wav` | `audio/wav` | the WAV bytes; `CustomAttributes: language=de` |

The language is a Whisper language code chosen by the user before recording.

The endpoint must answer with JSON in one of these shapes. Timestamps are in
seconds from the start of the clip, and they're what lets narration line up
with the recorded steps, so return them whenever you can:

```json
{"text": "...", "chunks": [{"timestamp": [0.0, 4.2], "text": "..."}]}
{"text": "...", "segments": [{"start": 0.0, "end": 4.2, "text": "..."}]}
```

A one-item array around either object is accepted too. Plain text works but
loses the timing, so narration is treated as one block per clip.

## Option A: deploy the reference handler

`inference.py` implements the contract with the Hugging Face `transformers`
Whisper pipeline. Deploy it in a Hugging Face PyTorch **inference** container
with the SageMaker Python SDK, choosing a `transformers`/`pytorch`/`python`
version combination that a current container image supports:

```python
from sagemaker.huggingface import HuggingFaceModel

model = HuggingFaceModel(
    role="<SageMaker execution role ARN>",
    entry_point="inference.py",
    source_dir=".",                      # this folder
    transformers_version="<version>",
    pytorch_version="<version>",
    py_version="<version>",
    env={"WHISPER_MODEL_ID": "openai/whisper-large-v3"},
)
model.deploy(
    initial_instance_count=1,
    instance_type="ml.g5.xlarge",        # any GPU instance; CPU works but is slow
    endpoint_name="skill-recorder-whisper",
)
```

Then deploy (or update) the service stack with
`AsrEndpointName=skill-recorder-whisper` and `AsrRequestFormat=json`.

## Option B: use an existing endpoint

If you already serve Whisper (or another model) on SageMaker, set
`AsrEndpointName` to it and pick the `AsrRequestFormat` it accepts. Check that
its response matches one of the shapes above.

## Cost

A real-time GPU endpoint bills for every hour it runs, used or not. For
occasional use, consider scaling the endpoint's instance count down outside
working hours. Requests are short (one clip each), so a single instance
handles many users.
