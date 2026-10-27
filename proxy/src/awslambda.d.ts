import type { Writable } from "node:stream";

/** Globals the Lambda Node.js runtime provides for response streaming. */
declare global {
  namespace awslambda {
    type ResponseStream = Writable;

    function streamifyResponse<TEvent>(
      handler: (event: TEvent, responseStream: ResponseStream, context: unknown) => Promise<void>,
    ): unknown;

    namespace HttpResponseStream {
      function from(
        responseStream: ResponseStream,
        metadata: { statusCode: number; headers?: Record<string, string> },
      ): ResponseStream;
    }
  }
}

export {};
