import PostalMime from "postal-mime";

export interface Env {
  MAUTIC_BASE_URL: string;
  MAUTIC_USERNAME: string;
  MAUTIC_PASSWORD: string;
}

/**
 * Contact was unsubscribed due to an unsuccessful send.
 */
const BOUNCED = 2;

async function addBounceToDnc(env: Env, email: string, comments: string) {
  const contactRes = await fetch(
    `${env.MAUTIC_BASE_URL}/api/contacts?search=${encodeURIComponent(email)}&limit=1`,
    {
      headers: {
        Authorization:
          "Basic " + btoa(`${env.MAUTIC_USERNAME}:${env.MAUTIC_PASSWORD}`),
      },
    }
  );

  if (!contactRes.ok) {
    throw new Error(
      `Mautic contact search failed: ${contactRes.status} ${await contactRes.text()}`
    );
  }

  const contactData = (await contactRes.json()) as {
    total: string;
    contacts: Record<string, { id: number }>;
  };

  if (contactData.total === "0") {
    console.log(`No contact found for ${email}, skipping DNC`);
    return;
  }

  const contactId = Object.values(contactData.contacts)[0].id;

  const dncRes = await fetch(
    `${env.MAUTIC_BASE_URL}/api/contacts/${contactId}/dnc/email/add`,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + btoa(`${env.MAUTIC_USERNAME}:${env.MAUTIC_PASSWORD}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reason: BOUNCED,
        comments,
      }),
    }
  );

  if (!dncRes.ok) {
    throw new Error(
      `Mautic DNC add failed: ${dncRes.status} ${await dncRes.text()}`
    );
  }

  console.log(`Added contact ${contactId} (${email}) to DNC list as bounced`);
}

function extractBouncedAddresses(parsed: {
  text?: string;
  html?: string;
  headers?: { key: string; value: string }[];
  attachments?: {
    mimeType: string;
    content: string | ArrayBuffer | Uint8Array;
  }[];
}): string[] {
  const addresses: Set<string> = new Set();
  const emailRegex = /[\w.+-]+@[\w.-]+\.\w{2,}/g;

  for (const attachment of parsed.attachments ?? []) {
    if (
      attachment.mimeType === "message/delivery-status" ||
      attachment.mimeType === "text/plain"
    ) {
      const content = attachment.content;
      const text =
        typeof content === "string"
          ? content
          : new TextDecoder().decode(content);
      const finalRecipientMatch = text.match(
        /Final-Recipient:\s*(?:rfc822;|smtp;)?\s*([\w.+-]+@[\w.-]+\.\w{2,})/i
      );
      if (finalRecipientMatch) {
        addresses.add(finalRecipientMatch[1].toLowerCase());
      }
      const originalRecipientMatch = text.match(
        /Original-Recipient:\s*(?:rfc822;|smtp;)?\s*([\w.+-]+@[\w.-]+\.\w{2,})/i
      );
      if (originalRecipientMatch) {
        addresses.add(originalRecipientMatch[1].toLowerCase());
      }
    }
  }

  if (addresses.size > 0) return [...addresses];

  const body = parsed.text ?? parsed.html ?? "";

  const failedRecipientHeader = (parsed.headers ?? []).find(
    (h) => h.key.toLowerCase() === "x-failed-recipients"
  );
  if (failedRecipientHeader) {
    const matches = failedRecipientHeader.value.match(emailRegex);
    if (matches) {
      for (const m of matches) addresses.add(m.toLowerCase());
    }
  }

  const patterns = [
    /delivery\s+to\s+(?:the\s+following\s+recipient[s]?\s+)?(?:has\s+)?failed[^]*?([\w.+-]+@[\w.-]+\.\w{2,})/i,
    /could\s+not\s+be\s+delivered\s+to[:\s]*([\w.+-]+@[\w.-]+\.\w{2,})/i,
    /undeliverable[^]*?([\w.+-]+@[\w.-]+\.\w{2,})/i,
    /rejected[^]*?([\w.+-]+@[\w.-]+\.\w{2,})/i,
    /bounced?[^]*?([\w.+-]+@[\w.-]+\.\w{2,})/i,
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) {
      addresses.add(match[1].toLowerCase());
      break;
    }
  }

  return [...addresses];
}

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: ExecutionContext
  ) {
    const rawEmail = await new Response(message.raw).arrayBuffer();
    const parsed = await new PostalMime().parse(rawEmail);

    const bouncedAddresses = extractBouncedAddresses(parsed);

    if (bouncedAddresses.length === 0) {
      console.log(
        `No bounced addresses found in email from ${message.from}, subject: ${parsed.subject}`
      );
      return;
    }

    console.log(
      `Found ${bouncedAddresses.length} bounced address(es): ${bouncedAddresses.join(", ")}`
    );

    const comments = `Bounce detected from email: ${parsed.subject ?? "(no subject)"}`;

    for (const addr of bouncedAddresses) {
      try {
        await addBounceToDnc(env, addr, comments);
      } catch (err) {
        console.error(`Failed to process bounce for ${addr}:`, err);
      }
    }
  },
} satisfies ExportedHandler<Env>;
