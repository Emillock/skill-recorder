/** Service settings, read from the Lambda environment (see template.yaml). */
export interface ProxyConfig {
  /** DynamoDB table of access tokens, keyed by `tokenHash`. */
  tokensTable: string;
  /** S3 bucket for uploaded screen frames. */
  imagesBucket: string;
  /** Region of the Bedrock endpoint (`bedrock-mantle.{region}.api.aws`). */
  bedrockRegion: string;
  /** Claude model IDs clients may request, without the `anthropic.` prefix. */
  allowedModels: string[];
  defaultModel: string;
  /** Model a refused request is retried on; empty disables the retry. */
  fallbackModel: string;
  /** Ceiling applied to each request's `max_tokens`. */
  maxOutputTokens: number;
  /** SageMaker endpoint for speech-to-text; empty disables `/v1/transcribe`. */
  asrEndpointName: string;
  /** How audio is sent to the endpoint (see sagemaker/README.md). */
  asrRequestFormat: "json" | "wav";
}

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,80}$/;

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().replace(/^anthropic\./, ""))
    .filter((item) => MODEL_ID.test(item));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required setting ${name}.`);
    return value;
  };
  const allowedModels = list(env.ALLOWED_MODELS);
  if (allowedModels.length === 0) throw new Error("ALLOWED_MODELS must list at least one Claude model ID.");
  const fallback = list(env.FALLBACK_MODEL)[0] ?? "";
  const maxOutputTokens = Number.parseInt(env.MAX_OUTPUT_TOKENS ?? "", 10);
  return {
    tokensTable: required("TOKENS_TABLE"),
    imagesBucket: required("IMAGES_BUCKET"),
    bedrockRegion: env.BEDROCK_REGION?.trim() || required("AWS_REGION"),
    allowedModels,
    defaultModel: allowedModels[0],
    fallbackModel: fallback,
    maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : 64_000,
    asrEndpointName: env.ASR_ENDPOINT_NAME?.trim() ?? "",
    asrRequestFormat: env.ASR_REQUEST_FORMAT?.trim() === "wav" ? "wav" : "json",
  };
}
