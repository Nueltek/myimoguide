/**
 * The slice of Meta's webhook payload we actually read.
 *
 * Deliberately partial: Meta adds fields without notice, and a strict schema
 * over the whole envelope turns their additions into our outages. Everything
 * is optional and narrowed at the point of use.
 */

export interface WhatsAppWebhookBody {
  object?: string;
  entry?: WebhookEntry[];
}

export interface WebhookEntry {
  id?: string;
  changes?: WebhookChange[];
}

export interface WebhookChange {
  field?: string;
  value?: WebhookValue;
}

export interface WebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: InboundMessage[];
  /** Delivery/read receipts. We acknowledge and ignore these. */
  statuses?: Array<{ id?: string; status?: string }>;
}

export interface InboundMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  button?: { text?: string };
  interactive?: {
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
}
