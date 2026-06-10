import { timingSafeEqual, createHash } from 'node:crypto';

/**
 * Constant-time string equality (finding #8). Both inputs are hashed to a fixed
 * 32-byte SHA-256 digest before comparison, so `timingSafeEqual` always sees
 * equal-length buffers and neither the contents NOR the length of the secret
 * leak through comparison timing. Use whenever a secret (bearer token, consent
 * phrase) is compared against attacker-influenceable input — never `===`/`!==`,
 * which short-circuits on the first differing byte.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
