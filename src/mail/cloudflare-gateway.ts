export interface CloudflareSendRequest {
  accountId: string;
  apiToken: string;
  from: string;
  to: string;
  subject: string;
  textBody: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface CloudflareSendResponse {
  delivered: string[];
  permanentBounces: string[];
  queued: string[];
  submittedAt: string;
}

interface CloudflareApiEnvelope {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: {
    delivered?: string[];
    permanent_bounces?: string[];
    queued?: string[];
  } | null;
}

export async function sendCloudflareMessage(request: CloudflareSendRequest): Promise<CloudflareSendResponse> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(request.accountId)}/email/sending/send`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${request.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: { address: request.from },
        to: request.to,
        subject: request.subject,
        text: request.textBody,
        reply_to: request.replyTo,
        headers: request.headers,
      }),
    },
  );

  const body = await response.json() as CloudflareApiEnvelope;
  if (!response.ok || body.success === false || !body.result) {
    const message = body.errors?.map((error) => error.message).filter(Boolean).join(", ")
      || "Cloudflare Email Sending failed";
    throw new Error(message);
  }

  return {
    delivered: body.result.delivered ?? [],
    permanentBounces: body.result.permanent_bounces ?? [],
    queued: body.result.queued ?? [],
    submittedAt: new Date().toISOString(),
  };
}
