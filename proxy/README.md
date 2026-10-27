# Skill Recorder service on AWS

A small AWS service that lets Skill Recorder run its AI work on your
organization's AWS account instead of GitHub Copilot:

- **Analysis and skill building** go to **Claude in Amazon Bedrock**.
- **Voice narration** is transcribed on a **SageMaker endpoint** you run.

Users don't need AWS access. Each person gets an access token from an
administrator and enters the service URL and token in Skill Recorder's
**AI settings**. The AWS credentials stay in the service.

```
Skill Recorder (desktop)                    AWS account
────────────────────────                    ───────────────────────────────────────────
recording, tools, redaction   ── HTTPS ──▶  Lambda function URL (streaming)
  Anthropic SDK  /v1/messages                ├─ checks token  ─▶ DynamoDB (token hashes)
  frames  /v1/uploads/images                 ├─ stores frames ─▶ S3 (deleted after 1 day)
  audio clips  /v1/transcribe                ├─ Messages API  ─▶ Claude in Amazon Bedrock
                                             └─ speech        ─▶ SageMaker endpoint
```

The desktop app keeps each conversation and runs the agent's tools locally,
because they read the recording on the user's computer. Every model call goes
through `POST /v1/messages`, which speaks the Anthropic Messages API, so the
app uses the regular Anthropic SDK pointed at this service.

## Routes

| Route | Purpose |
|---|---|
| `GET /v1/health` | Who the token belongs to, the allowed models, and whether transcription is set up. Used by **Test connection**. |
| `POST /v1/messages` | Anthropic Messages API (streaming or not), forwarded to Bedrock. Models outside `AllowedModels` are refused; `max_tokens` is capped. |
| `POST /v1/uploads/images` | Stores one screen frame and returns `srimg_<sha256>`. Conversations reference frames by that id, and the service inlines them before calling Bedrock, which keeps each request under Lambda's 6 MB limit. |
| `POST /v1/transcribe?language=xx` | One WAV clip to the SageMaker endpoint; returns `{ text, chunks }`. See [sagemaker/README.md](sagemaker/README.md). |

Every route requires `Authorization: Bearer <token>`. Errors use the Anthropic
API's error format, so the desktop SDK reports them as typed errors.

## Why a function URL, not API Gateway

Claude turns that read several screen frames can stream for minutes. API
Gateway's default integration timeout is 29 seconds, which would cut those
turns off. A Lambda function URL in `RESPONSE_STREAM` mode streams for up to 15
minutes. The URL is public; access is enforced by the per-user tokens. You can
put CloudFront and AWS WAF in front of it if your organization requires that.

## Prerequisites

- An AWS account with model access to the Claude models you'll allow
  (Bedrock console → Model access). Claude Opus 5.5, Sonnet 5.5, and Haiku 5.5
  are listed under "See Access" in the Bedrock docs; check the console for your
  account's status.
- AWS SAM CLI and Node.js 22 or later.
- Optional: a SageMaker speech-to-text endpoint (see
  [sagemaker/README.md](sagemaker/README.md)). Without one, voice narration
  can't be transcribed in AWS mode; analysis still works without it.

## Deploy

```bash
cd proxy
npm ci
npm test
npm run build              # bundles src/ into dist/index.mjs
sam deploy --guided        # first time; saves your answers to samconfig.toml
```

Parameters (all optional):

| Parameter | Default | Meaning |
|---|---|---|
| `AllowedModels` | `claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5` | Models users may request; the first is the default. |
| `FallbackModel` | `claude-opus-4-8` | Model a refused request is retried on (Bedrock has no server-side fallback). Empty disables it. |
| `BedrockRegion` | stack region | Region of the Bedrock endpoint. |
| `MaxOutputTokens` | `64000` | Cap on `max_tokens`. |
| `AsrEndpointName` | empty | SageMaker endpoint for speech-to-text. |
| `AsrRequestFormat` | `json` | `json` or `wav`, see the SageMaker README. |
| `ImageRetentionDays` | `1` | How long uploaded frames are kept. |
| `LogRetentionDays` | `30` | CloudWatch log retention. |
| `ReservedConcurrency` | `20` | Most requests served at once. |

The stack outputs `ServiceUrl` (give it to users) and `TokensTableName`.

The function's role may call `bedrock-mantle:CreateInference` on any resource.
Once you know your model ARNs, narrow `Resource` in `template.yaml` to them.

## Manage access tokens

Run these with your own AWS credentials:

```bash
npm run tokens -- create ana@example.com --table <TokensTableName> --note "laptop"
npm run tokens -- list --table <TokensTableName>
npm run tokens -- revoke ana@example.com --table <TokensTableName>
```

`create` prints the token once. Only its SHA-256 hash is stored. Revoked
tokens stop working within a minute (the service caches lookups briefly).

## Connect Skill Recorder

In Skill Recorder, open **AI settings**, choose **Claude on AWS**, enter the
`ServiceUrl` and the user's token, and click **Test connection**. For
development and evals, the same values can come from environment variables:
`SKILL_RECORDER_PROVIDER=aws`, `SKILL_RECORDER_PROXY_URL`,
`SKILL_RECORDER_PROXY_TOKEN`, and optionally `SKILL_RECORDER_MODEL`.

## What's stored and logged

- **Screen frames** the model asks to see are stored in S3, encrypted, for
  `ImageRetentionDays`, under a per-user prefix. Nothing else from a recording
  is stored by the service.
- **Logs** record the user, route, model, token counts, and outcome of each
  request. Prompts, frames, audio, and transcripts are never logged.
- Bedrock and SageMaker process requests under your AWS account's data
  handling terms.

## Troubleshooting

- **Every request fails with a Bedrock error about a beta or a model.** Check the
  model has access in the Bedrock console for `BedrockRegion`. The refusal
  retry sends the `fallback-credit-2026-07-01` beta on each request; if your
  region rejects it, redeploy with `FallbackModel` empty.
- **Test connection says the token was rejected.** The token may be revoked or
  mistyped; issue a new one with `npm run tokens -- create`.
- **"Image … isn't available anymore".** Frames expire after
  `ImageRetentionDays`. Start the analysis again to re-upload them.

## Costs

You pay for Claude on Bedrock per token, the SageMaker endpoint per instance
hour, and small Lambda, S3, and DynamoDB charges. The desktop app enables
prompt caching, so each turn of a conversation pays full price only for what
was added since the previous call. Usage per user is in the CloudWatch logs.
