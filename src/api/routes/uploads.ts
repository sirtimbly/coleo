import { randomBytes } from "crypto";
import { mkdir } from "fs/promises";
import { extname, join } from "path";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getColeoDir } from "../../config";
import {
  createUploadedMedia,
  getUploadedMediaByToken,
} from "../../db/state";
import { HttpError } from "../middleware";
import type { TaskAttachment } from "../../types";

interface UploadContext {
  Variables: {
    db: Database;
    coleoDir: string;
  };
}

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const MIME_EXTENSION_MAP: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) {
    return "upload";
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function getUploadExtension(file: File): string {
  const originalExtension = extname(file.name || "").toLowerCase();
  if (originalExtension) {
    return originalExtension;
  }

  return MIME_EXTENSION_MAP[file.type] || ".bin";
}

function getPublicBaseUrl(requestUrl: string): string {
  const explicit = process.env.COLEO_PUBLIC_API_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }

  return new URL(requestUrl).origin;
}

function toTaskAttachment(
  media: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  },
  requestUrl: string,
  accessToken: string,
): TaskAttachment {
  const publicBaseUrl = getPublicBaseUrl(requestUrl);
  return {
    uploadId: media.id,
    kind: "image",
    filename: media.filename,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    contentUrl: `${publicBaseUrl}/uploads/${media.id}/content?token=${encodeURIComponent(accessToken)}`,
  };
}

export function createUploadApiRoutes() {
  const app = new Hono<UploadContext>();

  app.use("*", async (c, next) => {
    c.set("coleoDir", getColeoDir());
    await next();
  });

  app.post("/images", async (c) => {
    const db = c.get("db");
    const coleoDir = c.get("coleoDir");
    const formData = await c.req.raw.formData();
    const maybeFile = formData.get("file");

    if (!(maybeFile instanceof File)) {
      throw HttpError.badRequest("file is required");
    }

    if (!maybeFile.type.startsWith("image/")) {
      throw HttpError.badRequest("Only image uploads are supported");
    }

    if (maybeFile.size > MAX_IMAGE_SIZE_BYTES) {
      throw HttpError.badRequest(`Image exceeds ${MAX_IMAGE_SIZE_BYTES} byte limit`);
    }

    const uploadId = `upload-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const accessToken = randomBytes(24).toString("hex");
    const filename = sanitizeFilename(maybeFile.name || "upload");
    const extension = getUploadExtension(maybeFile);
    const uploadsDir = join(coleoDir, "uploads");
    const storagePath = join(uploadsDir, `${uploadId}${extension}`);

    await mkdir(uploadsDir, { recursive: true });
    await Bun.write(storagePath, maybeFile);

    createUploadedMedia(db, {
      id: uploadId,
      kind: "image",
      filename,
      mimeType: maybeFile.type,
      sizeBytes: maybeFile.size,
      storagePath,
      accessToken,
    });

    const attachment = toTaskAttachment(
      {
        id: uploadId,
        filename,
        mimeType: maybeFile.type,
        sizeBytes: maybeFile.size,
      },
      c.req.url,
      accessToken,
    );

    return c.json({ attachment }, 201);
  });

  return app;
}

export function createUploadContentRoutes() {
  const app = new Hono<UploadContext>();

  app.get("/:id/content", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const token = c.req.query("token");

    if (!id || !token) {
      throw HttpError.unauthorized("Missing upload token");
    }

    const media = getUploadedMediaByToken(db, id, token);
    if (!media) {
      throw HttpError.notFound(`Uploaded media not found: ${id}`);
    }

    const file = Bun.file(media.storagePath);
    if (!(await file.exists())) {
      throw HttpError.notFound(`Uploaded media content missing: ${id}`);
    }

    return new Response(file, {
      headers: {
        "Content-Type": media.mimeType,
        "Content-Length": String(media.sizeBytes),
        "Content-Disposition": `inline; filename="${media.filename}"`,
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  });

  return app;
}
