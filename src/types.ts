import type { Conversation } from './conversation';

/** Worker bindings. Keep in sync with wrangler.jsonc. */
export interface Env {
  // Queues
  INBOUND: Queue<InboundJob>;

  // Durable Objects. Parameterised so the stub exposes the class's own
  // methods over RPC instead of a bare fetch handler.
  CONVERSATION: DurableObjectNamespace<Conversation>;

  // R2
  SOURCES: R2Bucket;

  // Plain vars
  WHATSAPP_API_VERSION: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';

  // Secrets
  WHATSAPP_VERIFY_TOKEN: string;
  WHATSAPP_APP_SECRET: string;
  WHATSAPP_TOKEN: string;
  WHATSAPP_PHONE_ID: string;
  ANTHROPIC_API_KEY: string;
  DATABASE_URL: string;
}

/**
 * One unit of work handed from the webhook to the consumer.
 *
 * Deliberately small and self-contained: the webhook does no lookups, so
 * nothing here depends on state that might have moved by the time the
 * consumer picks it up.
 */
export interface InboundJob {
  /** WhatsApp message id — used to drop Meta's duplicate deliveries. */
  messageId: string;
  /** Sender's WhatsApp number in E.164, no plus. */
  from: string;
  /** Our phone number id, so one Worker can serve several numbers later. */
  phoneNumberId: string;
  /** Message text, or the transcript placeholder for audio. */
  text: string;
  /** 'text' | 'audio' | other — audio is transcribed in the consumer. */
  kind: 'text' | 'audio' | 'unsupported';
  /** Media id for audio messages, to fetch and transcribe. */
  mediaId?: string;
  /** Unix seconds, from Meta. */
  timestamp: number;
}
