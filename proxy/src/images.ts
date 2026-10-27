import { createHash } from "node:crypto";

import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { contentType, HttpError, isObject, json, type ProxyRequest, type ProxyResponse } from "./http.ts";

/**
 * Screen frames are uploaded once and referenced in conversations as
 * `{"type":"image","source":{"type":"file","file_id":"srimg_<sha256>"}}`.
 * Bedrock doesn't support file references, so before forwarding a request the
 * proxy swaps each reference for the stored image. This keeps requests from the
 * desktop small (Lambda accepts at most 6 MB) however many frames a long
 * conversation has viewed. The bucket's lifecycle rule deletes frames after
 * `ImageRetentionDays` (template.yaml).
 */

export const IMAGE_ID = /^srimg_([a-f0-9]{64})$/;
/** Claude's per-image limit. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PARALLEL_LOADS = 8;

export interface StoredImage {
  data: Buffer;
  contentType: string;
}

export interface ImageStore {
  put(key: string, image: StoredImage): Promise<void>;
  get(key: string): Promise<StoredImage | null>;
}

/** Images are stored per user, so one user can't reference another's frames. */
export function imageKey(user: string, digest: string): string {
  const owner = createHash("sha256").update(user).digest("hex").slice(0, 32);
  return `images/${owner}/${digest}`;
}

/** The image type the bytes actually are, from their signature. */
export function sniffImageType(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.length >= 6 && data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

export async function handleImageUpload(req: ProxyRequest, user: string, store: ImageStore): Promise<ProxyResponse> {
  const type = contentType(req.headers);
  if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(type)) {
    throw new HttpError(400, "invalid_request_error", "Upload a JPEG, PNG, GIF, or WebP image.");
  }
  if (req.body.length === 0) throw new HttpError(400, "invalid_request_error", "The image is empty.");
  if (req.body.length > MAX_IMAGE_BYTES) {
    throw new HttpError(413, "request_too_large", "Images can be at most 5 MB.");
  }
  if (sniffImageType(req.body) !== type) {
    throw new HttpError(400, "invalid_request_error", "The image data doesn't match its content type.");
  }
  const digest = createHash("sha256").update(req.body).digest("hex");
  await store.put(imageKey(user, digest), { data: req.body, contentType: type });
  return json(200, { id: `srimg_${digest}` });
}

/**
 * Replace every uploaded-image reference in `messages` (including inside tool
 * results) with the image itself. Mutates `messages`; returns how many were inlined.
 */
export async function inlineImages(messages: unknown, user: string, store: ImageStore): Promise<number> {
  if (!Array.isArray(messages)) return 0;
  const blocks: Record<string, unknown>[] = [];
  const visit = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "image" && isObject(block.source) && block.source.type === "file") blocks.push(block);
      if (block.type === "tool_result") visit(block.content);
    }
  };
  for (const message of messages) if (isObject(message)) visit(message.content);
  if (blocks.length === 0) return 0;

  const ids = new Set<string>();
  for (const block of blocks) {
    const id = (block.source as Record<string, unknown>).file_id;
    if (typeof id !== "string" || !IMAGE_ID.test(id)) {
      throw new HttpError(
        400,
        "invalid_request_error",
        "File references aren't available on Bedrock. Upload images to /v1/uploads/images and reference the returned id.",
      );
    }
    ids.add(id);
  }

  const loaded = new Map<string, StoredImage>();
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const digest = IMAGE_ID.exec(id)![1];
      const image = await store.get(imageKey(user, digest));
      if (!image) {
        throw new HttpError(
          400,
          "invalid_request_error",
          `Image ${id} isn't available anymore; uploaded frames are deleted after a short retention period. Start the analysis again.`,
        );
      }
      loaded.set(id, image);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_LOADS, queue.length) }, worker));

  for (const block of blocks) {
    const image = loaded.get((block.source as Record<string, unknown>).file_id as string)!;
    block.source = { type: "base64", media_type: image.contentType, data: image.data.toString("base64") };
  }
  return blocks.length;
}

export class S3ImageStore implements ImageStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(client: S3Client, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  async put(key: string, image: StoredImage): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: image.data, ContentType: image.contentType }),
    );
  }

  async get(key: string): Promise<StoredImage | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      return {
        data: Buffer.from(await result.Body.transformToByteArray()),
        contentType: result.ContentType ?? "image/jpeg",
      };
    } catch (err) {
      if (err instanceof Error && (err.name === "NoSuchKey" || err.name === "NotFound")) return null;
      throw err;
    }
  }
}

/** Keeps recently used images in memory across requests on a warm Lambda,
 *  since each turn of a conversation resends every earlier frame reference. */
export class CachedImageStore implements ImageStore {
  private readonly inner: ImageStore;
  private readonly maxBytes: number;
  private readonly cache = new Map<string, StoredImage>();
  private bytes = 0;

  constructor(inner: ImageStore, maxBytes = 128 * 1024 * 1024) {
    this.inner = inner;
    this.maxBytes = maxBytes;
  }

  async put(key: string, image: StoredImage): Promise<void> {
    await this.inner.put(key, image);
    this.remember(key, image);
  }

  async get(key: string): Promise<StoredImage | null> {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const image = await this.inner.get(key);
    if (image) this.remember(key, image);
    return image;
  }

  private remember(key: string, image: StoredImage): void {
    const existing = this.cache.get(key);
    if (existing) this.bytes -= existing.data.length;
    this.cache.delete(key);
    this.cache.set(key, image);
    this.bytes += image.data.length;
    for (const [oldest, value] of this.cache) {
      if (this.bytes <= this.maxBytes) break;
      this.cache.delete(oldest);
      this.bytes -= value.data.length;
    }
  }
}
