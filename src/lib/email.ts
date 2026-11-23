import { env } from 'cloudflare:workers';

export interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: string; contentType: string }[];
  /** Resend drops a repeat send with the same key within 24 hours, so a retried cron doesn't mail twice. */
  idempotencyKey?: string;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Sends an e-mail through the Resend API. Throws when Resend is not configured or rejects the e-mail. */
export async function sendEmail(email: Email): Promise<void> {
  // Secrets Store binding (wrangler.jsonc); get() throws when the secret doesn't exist in the store.
  const apiKey = await env.RESEND_API_KEY.get().catch((e: unknown) => {
    throw new Error(`RESEND_API_KEY is not available from the Secrets Store: ${e instanceof Error ? e.message : e}`);
  });
  if (!env.REPORT_FROM_EMAIL) throw new Error('REPORT_FROM_EMAIL is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(email.idempotencyKey && { 'Idempotency-Key': email.idempotencyKey }),
    },
    body: JSON.stringify({
      from: env.REPORT_FROM_EMAIL,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: email.attachments?.map((a) => ({
        filename: a.filename,
        content: toBase64(a.content),
        content_type: a.contentType,
      })),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend API returned HTTP ${response.status} ${detail.slice(0, 300)}`);
  }
}

/** Loose check that catches typos; Resend does the real validation. */
export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(value);
}
