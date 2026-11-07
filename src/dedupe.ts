/**
 * Duplicate suppression for inbound WhatsApp messages.
 *
 * Two different things arrive as "the same message again", and they need
 * opposite answers:
 *
 *   A Meta duplicate. Meta re-delivers the webhook when our 200 is slow.
 *   It enqueues a SECOND queue message carrying the same WhatsApp id, at
 *   attempt 1. It must be skipped, or the user gets two replies.
 *
 *   Our own retry. A failed attempt is re-delivered by the queue as the
 *   SAME queue message at attempt 2, 3... It must PROCEED, or the failure
 *   becomes permanent silence.
 *
 * The first version of this code could not tell them apart. It marked a
 * message "seen" before doing any work, so every retry looked like a
 * duplicate and was dropped. Any error after the claim — an API failure,
 * a timeout — left the user with a typing indicator and then nothing,
 * forever, and the final-attempt apology meant to prevent exactly that
 * was unreachable.
 *
 * The fix is two states. A claim marks a message 'processing'; only a
 * DELIVERED reply marks it 'done'. A processing message seen again at
 * attempt > 1 is our retry and proceeds; at attempt 1 it is Meta's
 * duplicate of something still in flight, and is skipped.
 */

export type ClaimState = 'processing' | 'done' | undefined;
export type ClaimDecision = 'proceed' | 'skip';

export function decideClaim(state: ClaimState, attempt: number): ClaimDecision {
  if (state === undefined) return 'proceed';
  if (state === 'done') return 'skip';
  // 'processing': ours to retry, or Meta's duplicate of an in-flight one.
  return attempt > 1 ? 'proceed' : 'skip';
}
