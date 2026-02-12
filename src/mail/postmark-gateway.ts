interface PostmarkAddress {
  Name?: string;
  Email?: string;
}

interface PostmarkHeader {
  Name?: string;
  Value?: string;
}

interface PostmarkInboundPayload {
  From?: string;
  FromFull?: PostmarkAddress;
  To?: string;
  ToFull?: PostmarkAddress[];
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  MessageID?: string;
  Headers?: PostmarkHeader[];
}

export interface NormalizedInboundMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  headers: Record<string, string>;
}

export interface PostmarkSendRequest {
  apiToken: string;
  from: string;
  to: string;
  subject: string;
  textBody: string;
  replyTo?: string;
}

export interface PostmarkSendResponse {
  messageId: string;
  submittedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isLikelyEmail(value: string): boolean {
  // Keep validation intentionally permissive to support common mailbox forms.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function resolveEmail(primary: unknown, secondary?: unknown): string | undefined {
  const candidates = [primary, secondary];

  for (const candidate of candidates) {
    const normalized = asNonEmptyString(candidate);
    if (normalized && isLikelyEmail(normalized)) {
      return normalized;
    }
  }

  return undefined;
}

function resolveBody(textBody: unknown, htmlBody: unknown): string {
  const normalizedText = asNonEmptyString(textBody);
  if (normalizedText) {
    return normalizedText;
  }

  const normalizedHtml = asNonEmptyString(htmlBody);
  if (normalizedHtml) {
    return normalizedHtml;
  }

  return "";
}

export function normalizePostmarkInbound(payload: unknown): NormalizedInboundMessage {
  if (!isRecord(payload)) {
    throw new Error("Inbound payload must be an object");
  }

  const typedPayload = payload as PostmarkInboundPayload;
  const from = resolveEmail(typedPayload.From, typedPayload.FromFull?.Email) ?? "unknown@postmark.local";
  const to = resolveEmail(typedPayload.To, typedPayload.ToFull?.[0]?.Email) ?? "brain@coleo.local";
  const subject = asNonEmptyString(typedPayload.Subject) ?? "(no subject)";
  const body = resolveBody(typedPayload.TextBody, typedPayload.HtmlBody);

  const headers: Record<string, string> = {
    "x-mail-provider": "postmark",
  };

  const messageId = asNonEmptyString(typedPayload.MessageID);
  if (messageId) {
    headers["x-postmark-message-id"] = messageId;
  }

  if (Array.isArray(typedPayload.Headers)) {
    for (const header of typedPayload.Headers) {
      const headerName = asNonEmptyString(header?.Name);
      const headerValue = asNonEmptyString(header?.Value);
      if (headerName && headerValue) {
        headers[headerName.toLowerCase()] = headerValue;
      }
    }
  }

  return {
    from,
    to,
    subject,
    body,
    headers,
  };
}

export async function sendPostmarkMessage(request: PostmarkSendRequest): Promise<PostmarkSendResponse> {
  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": request.apiToken,
    },
    body: JSON.stringify({
      From: request.from,
      To: request.to,
      Subject: request.subject,
      TextBody: request.textBody,
      ReplyTo: request.replyTo,
    }),
  });

  const responseBody = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof responseBody.Message === "string" ? responseBody.Message : "Postmark send failed";
    throw new Error(message);
  }

  const messageId = typeof responseBody.MessageID === "string" ? responseBody.MessageID : "unknown";

  return {
    messageId,
    submittedAt: new Date().toISOString(),
  };
}
