/**
 * Group subscriptions — KV-backed data model for team and enterprise seats.
 *
 * Three new KV maps stored under BILLING_KV:
 *
 *   group:{id}          →  GroupRecord   — group metadata: owner, members, seat count, plan
 *   domain:{domain}     →  DomainRecord  — domain allowlist; linked 1:1 to a GroupRecord
 *   member:{email}      →  MemberRecord  — reverse lookup: which group owns this seat
 *   voucher:{code}      →  VoucherRecord — shareable redemption codes (non-Stripe gifting)
 *   revoked:{email}     →  (tombstone)   — set on immediate-offboarding; checked at poll time
 *   gifted:{email}      →  number        — gift-seat counter per Pro user (abuse cap)
 *   audit:{ts}-{rand}   →  AuditEntry    — immutable lifecycle event log
 *
 * GroupRecord.members stores objects (not plain strings) so per-member overrides
 * (TTL, features, activatedAt) live alongside the email without a separate lookup.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GroupMember {
  email: string;
  /** When this member first claimed their token (deep link opened / poll hit). */
  activatedAt?: number;
  /** Per-member token TTL in days; overrides the group default. */
  ttlOverride?: number;
  /** Per-member feature override; overrides the group default when present. */
  features?: string[];
}

export interface GroupRecord {
  id: string;
  ownerEmail: string;
  plan: string;
  features: string[];
  seatCount: number;
  members: GroupMember[];
  subscriptionId?: string;
  /** Random 48-hex-char secret for owner self-service URL. */
  adminSecret: string;
  createdAt: number;
  updatedAt: number;
  /** Per-token TTL in days. 0 = permanent (exp set to year 2100). */
  ttlDays?: number;
  /** Optional onboarding bundle tag sent to the desktop on first claim. */
  onboardingBundle?: string;
}

export interface DomainRecord {
  domain: string;
  /** GroupRecord id backing this domain's seat pool. */
  groupId: string;
  plan: string;
  features: string[];
  /** Per-token TTL in days. 0 = permanent. */
  ttlDays: number;
  createdAt: number;
}

export interface MemberRecord {
  groupId: string;
}

export interface VoucherRecord {
  code: string;
  plan: string;
  features: string[];
  /** Per-token TTL in days. 0 = permanent. */
  ttlDays: number;
  maxRedemptions: number;
  redemptionCount: number;
  createdAt: number;
}

export type AuditAction = 'grant' | 'revoke' | 'claim' | 'domain-auto' | 'voucher-redeem' | 'gift' | 'extend' | 'group-create' | 'group-delete' | 'member-add' | 'member-remove';

export interface AuditEntry {
  ts: number;
  action: AuditAction;
  email: string;
  groupId?: string;
  adminNote?: string;
  ip?: string;
}

// ── TTL constants ──────────────────────────────────────────────────────────────

const GROUP_TTL_SECONDS   = 2 * 365 * 24 * 60 * 60;   // 2 years
const REVOKED_TTL_SECONDS = 365 * 24 * 60 * 60;        // 1 year (longer than any token)
const AUDIT_TTL_SECONDS   = 3 * 365 * 24 * 60 * 60;   // 3 years
const MEMBER_TTL_SECONDS  = 2 * 365 * 24 * 60 * 60;   // 2 years

/** exp Unix seconds used for "permanent" tokens (2100-01-01 00:00:00 UTC). */
export const PERMANENT_EXP = 4102444800;

/** Resolve the effective ttlDays to an exp Unix timestamp.
 *  ttlDays === 0 → PERMANENT_EXP; otherwise now + days. */
export function resolveTtlToExp(ttlDays: number): number {
  if (ttlDays === 0) return PERMANENT_EXP;
  return Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
}

/** Effective TTL days for mintLicenseToken — 0 maps to a large sentinel so
 *  the token server knows to use PERMANENT_EXP. Pass through to mintLicenseToken
 *  which already accepts a number-of-days arg; we handle 0 → huge-number here. */
export function effectiveTtlDays(ttlDays: number): number {
  if (ttlDays === 0) return Math.round((PERMANENT_EXP - Date.now() / 1000) / 86400);
  return ttlDays;
}

// ── Group ──────────────────────────────────────────────────────────────────────

export async function putGroup(kv: KVNamespace, rec: GroupRecord): Promise<void> {
  await kv.put(`group:${rec.id}`, JSON.stringify(rec), { expirationTtl: GROUP_TTL_SECONDS });
}

export async function getGroup(kv: KVNamespace, id: string): Promise<GroupRecord | null> {
  const raw = await kv.get(`group:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as GroupRecord; } catch { return null; }
}

export async function deleteGroup(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(`group:${id}`);
}

/** Find a GroupRecord by its Stripe subscriptionId. O(1) via a secondary index
 *  key `gsub:{subscriptionId}` → `{groupId}`. */
export async function getGroupBySubscription(kv: KVNamespace, subscriptionId: string): Promise<GroupRecord | null> {
  const raw = await kv.get(`gsub:${subscriptionId}`);
  if (!raw) return null;
  try {
    const { groupId } = JSON.parse(raw) as { groupId: string };
    return getGroup(kv, groupId);
  } catch { return null; }
}

export async function putGroupSubscriptionIndex(kv: KVNamespace, subscriptionId: string, groupId: string): Promise<void> {
  await kv.put(`gsub:${subscriptionId}`, JSON.stringify({ groupId }), { expirationTtl: GROUP_TTL_SECONDS });
}

// ── Domain ────────────────────────────────────────────────────────────────────

export async function putDomain(kv: KVNamespace, rec: DomainRecord): Promise<void> {
  await kv.put(`domain:${rec.domain.toLowerCase()}`, JSON.stringify(rec));
}

export async function getDomain(kv: KVNamespace, domain: string): Promise<DomainRecord | null> {
  const raw = await kv.get(`domain:${domain.toLowerCase()}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as DomainRecord; } catch { return null; }
}

export async function deleteDomain(kv: KVNamespace, domain: string): Promise<void> {
  await kv.delete(`domain:${domain.toLowerCase()}`);
}

// ── Member ────────────────────────────────────────────────────────────────────

export async function putMember(kv: KVNamespace, email: string, rec: MemberRecord): Promise<void> {
  await kv.put(`member:${email.toLowerCase()}`, JSON.stringify(rec), { expirationTtl: MEMBER_TTL_SECONDS });
}

export async function getMember(kv: KVNamespace, email: string): Promise<MemberRecord | null> {
  const raw = await kv.get(`member:${email.toLowerCase()}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as MemberRecord; } catch { return null; }
}

export async function deleteMember(kv: KVNamespace, email: string): Promise<void> {
  await kv.delete(`member:${email.toLowerCase()}`);
}

// ── Voucher ───────────────────────────────────────────────────────────────────

export async function putVoucher(kv: KVNamespace, rec: VoucherRecord): Promise<void> {
  await kv.put(`voucher:${rec.code.toUpperCase()}`, JSON.stringify(rec));
}

export async function getVoucher(kv: KVNamespace, code: string): Promise<VoucherRecord | null> {
  const raw = await kv.get(`voucher:${code.toUpperCase()}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as VoucherRecord; } catch { return null; }
}

export async function deleteVoucher(kv: KVNamespace, code: string): Promise<void> {
  await kv.delete(`voucher:${code.toUpperCase()}`);
}

// ── Revocation ────────────────────────────────────────────────────────────────

export async function revokeEmail(kv: KVNamespace, email: string): Promise<void> {
  await kv.put(`revoked:${email.toLowerCase()}`, '1', { expirationTtl: REVOKED_TTL_SECONDS });
}

export async function isRevoked(kv: KVNamespace, email: string): Promise<boolean> {
  const v = await kv.get(`revoked:${email.toLowerCase()}`);
  return v !== null;
}

export async function unrevoke(kv: KVNamespace, email: string): Promise<void> {
  await kv.delete(`revoked:${email.toLowerCase()}`);
}

// ── Gift counter ──────────────────────────────────────────────────────────────

export const GIFT_SEAT_CAP = 2;

export async function getGiftCount(kv: KVNamespace, email: string): Promise<number> {
  const raw = await kv.get(`gifted:${email.toLowerCase()}`);
  return raw ? parseInt(raw, 10) : 0;
}

export async function incrementGiftCount(kv: KVNamespace, email: string): Promise<number> {
  const current = await getGiftCount(kv, email);
  const next = current + 1;
  await kv.put(`gifted:${email.toLowerCase()}`, String(next));
  return next;
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export async function writeAudit(kv: KVNamespace, entry: AuditEntry): Promise<void> {
  const rand = Math.random().toString(36).slice(2, 8);
  const key = `audit:${String(entry.ts).padStart(16, '0')}-${rand}`;
  await kv.put(key, JSON.stringify(entry), { expirationTtl: AUDIT_TTL_SECONDS });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a cryptographically random hex string of `byteLen` bytes. */
export function randomHex(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
