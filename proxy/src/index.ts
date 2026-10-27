import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SageMakerRuntimeClient } from "@aws-sdk/client-sagemaker-runtime";

import { handleRequest, type Deps } from "./app.ts";
import { CachedTokenStore, DynamoTokenStore } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { CachedImageStore, S3ImageStore } from "./images.ts";
import { toProxyRequest, type FunctionUrlEvent } from "./lambda-event.ts";
import { MantleGateway } from "./messages.ts";
import { SageMakerSpeechEndpoint } from "./transcribe.ts";

let deps: Deps | null = null;

function productionDeps(): Deps {
  const config = loadConfig();
  return {
    config,
    tokens: new CachedTokenStore(new DynamoTokenStore(new DynamoDBClient({}), config.tokensTable)),
    images: new CachedImageStore(new S3ImageStore(new S3Client({}), config.imagesBucket)),
    models: new MantleGateway(config),
    speech: config.asrEndpointName
      ? new SageMakerSpeechEndpoint(new SageMakerRuntimeClient({}), config.asrEndpointName)
      : null,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

export const handler = awslambda.streamifyResponse<FunctionUrlEvent>(async (event, responseStream) => {
  deps ??= productionDeps();
  const response = await handleRequest(toProxyRequest(event), deps);
  const out = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: response.status,
    headers: response.headers,
  });
  const source = "stream" in response ? Readable.from(response.stream) : Readable.from([response.body]);
  await pipeline(source, out);
});
