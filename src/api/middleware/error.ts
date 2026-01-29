/**
 * Error handling middleware
 */
import type { Context, Next } from "hono";

export async function errorHandler(c: Context, next: Next): Promise<void | Response> {
  try {
    await next();
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    // Don't log 404s for GET requests - they're expected when checking if resources exist
    if (!(status === 404 && c.req.method === "GET")) {
      console.error("Unhandled error:", err);
    }

    const message = err instanceof Error ? err.message : "Internal server error";

    return c.json(
      {
        error: status === 500 ? "Internal server error" : message,
        ...(process.env.NODE_ENV === "development" && {
          stack: err instanceof Error ? err.stack : undefined,
        }),
      },
      status as 400 | 401 | 403 | 404 | 500
    );
  }
}

/**
 * HTTP Error class for throwing errors with status codes
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }

  static badRequest(message: string): HttpError {
    return new HttpError(400, message);
  }

  static unauthorized(message: string): HttpError {
    return new HttpError(401, message);
  }

  static forbidden(message: string): HttpError {
    return new HttpError(403, message);
  }

  static notFound(message: string): HttpError {
    return new HttpError(404, message);
  }

  static internal(message: string): HttpError {
    return new HttpError(500, message);
  }
}
