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

export function normalizePostmarkInbound(payload: unknown): NormalizedInboundMessage {
  if (!isRecord(payload)) {
    throw new Error("Inbound payload must be an object");
  }

  const typedPayload = payload as PostmarkInboundPayload;
  const from = typedPayload.From ?? typedPayload.FromFull?.Email ?? "unknown@postmark.local";
  const to = typedPayload.To ?? typedPayload.ToFull?.[0]?.Email ?? "brain@coleo.local";
  const subject = typedPayload.Subject ?? "(no subject)";
  const body = typedPayload.TextBody ?? typedPayload.HtmlBody ?? "";

  const headers: Record<string, string> = {
    "x-mail-provider": "postmark",
  };

  if (typedPayload.MessageID) {
    headers["x-postmark-message-id"] = typedPayload.MessageID;
  }

  if (Array.isArray(typedPayload.Headers)) {
    for (const header of typedPayload.Headers) {
      if (header?.Name && header.Value) {
        headers[header.Name.toLowerCase()] = header.Value;
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
