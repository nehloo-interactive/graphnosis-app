---
title: Enterprise RBAC
description: Sharing roles, MCP tool capabilities, and SSO roadmap for Graphnosis Enterprise.
---

# Enterprise RBAC

Graphnosis Enterprise extends sharing tokens beyond legacy **viewer** and **editor** roles. Each role grants a subset of **MCP tool capabilities** enforced server-side in `tools/list` and `tools/call` — the Settings UI and `/admin/provision` cannot bypass the matrix.

## Sharing roles

| Role | Typical use | MCP highlights |
|------|-------------|----------------|
| `recall-only` / `viewer` | Read-only collaborators | `recall`, `recall_obligations`, `list_skills`, `get_skill` |
| `remember` | AI can save but not edit | + `remember` |
| `edit-approve` | Propose edits; owner approves in app | + `edit` / `correct` |
| `editor` | Full write except skill training | + `apply`, `forget`, `ingest`, `walk_skill`, `save_skill_run`, `resume_skill_run` |
| `skill-train` | Skill trainers (Enterprise) | + `train_skill`, `export_skill` |
| `admin-audit` | Compliance / IT audit (Enterprise) | + `recall_as_of`, `audit_memory`, audit tools |

`owner` is reserved for the cortex passphrase holder — not minted as a share token.

Role definitions and capability mapping live in `packages/graphnosis-app-core/src/settings/rbac.ts`.

## Provisioning tokens

**Settings → Team Admin** supports all assignable roles. Enterprise-only roles (`skill-train`, `admin-audit`) require an Enterprise license.

**HTTP MCP — `POST /admin/provision`** (Enterprise, master bearer token only):

```json
{
  "name": "Alice — compliance",
  "role": "admin-audit",
  "engrams": ["compliance"],
  "expiresAt": 1735689600000
}
```

Integrate with MDM or IdP onboarding scripts to distribute scoped bearer tokens without manual key exchange.

## Session lease (multi-device UX)

When a sidecar starts, it writes `session.lease` in the cortex directory — a heartbeat file (not the authoritative write lock). If another device holds a fresh lease, the sidecar logs a warning; conflicting writes still fail on `.lockfile`.

The desktop app can query `cortex:sessionLease` IPC for “another session may be open” banners.

## SAML / OIDC

### Phase 1 (shipped)

Enterprise SSO **configuration** in Settings — OIDC issuer/client, break-glass passphrase toggle, IdP group → sharing role mapping table. IPC: `sso:get`, `sso:set`, `sso:status`, `sso:resolveRole` (preview). Types live in `packages/graphnosis-app-core/src/settings/sso.ts`.

### Phase 2 (shipped)

**Federated OIDC unlock** on the desktop lock screen:

- Authorization Code + PKCE via system browser and loopback callback (`http://127.0.0.1:4580/sso/callback`)
- Confidential client secret + org federated unlock key stored in the OS credential store per Mac
- `federated.master.enc` wraps the cortex data key; owner recovery passphrase remains valid

### Phase 3 (shipped)

**Production-ready enterprise SSO** for Entra ID, Okta, and Google Workspace OIDC:

| Capability | Behavior |
|------------|----------|
| Lock screen UX | “Sign in with Microsoft/Google/Okta” when issuer is recognized; always shown when SSO is configured + enabled |
| IdP reachability | Pre-flight probe of `/.well-known/openid-configuration` before opening the browser; helpful VPN message when unreachable |
| Tenant binding | Optional `oidcTenantId`; ID-token `iss` must match configured issuer; Entra `tid` must match when present |
| Break-glass | Passphrase unlock remains when `breakGlassPassphrase` is enabled |
| Domain seat UX | Domain OTP de-emphasized in license modal when SSO is active — lock-screen sign-in is the primary path |
| IPC | `sso:discover`, extended `sso:status` (`idpReachable`, `suggestedButtonLabel`, `tenantHint`) |
| Tauri | `discover_sso_unlock` (pre-unlock probe subprocess) |

**Popular IdP issuer patterns:**

- **Entra / Azure AD:** `https://login.microsoftonline.com/{tenant-id}/v2.0`
- **Okta:** `https://{your-domain}.okta.com`
- **Google Workspace:** `https://accounts.google.com`

**Enterprise license JWT (optional pattern):** Your billing server can embed `allowedTenantId` or `allowedIssuer` in the Enterprise JWT. The desktop validates IdP tokens against cortex SSO config (`issuer` + optional `oidcTenantId`) at unlock time — align JWT claims with SSO settings during org provisioning.

**Multi-device federated key (limits):** Each Mac needs SSO credentials in the OS keychain. An admin (or any user with owner passphrase) must **Save SSO settings once while unlocked** on each device to sync the federated unlock key and client secret. The encrypted `federatedUnlockKeyEnc` in settings cannot be used pre-unlock without the cortex data key. Per-user org subkeys remain Phase 4.

**Deferred to Phase 4:**

- SAML 2.0 SP-initiated flow
- Per-user org cortex subkeys
- Automatic keychain provisioning on first IdP login without prior admin save

### OIDC vs SAML (desktop)

| | OIDC | SAML |
|---|------|------|
| Best for | Okta, Azure AD, Google Workspace | Legacy enterprise portals |
| Desktop flow | System browser + loopback callback (Phase 2–3) | Browser redirect / IdP-initiated (Phase 4) |
| Group claims | JWT `groups` claim (configurable) | SAML attribute statements |

**Recommendation:** OIDC-first for the Tauri desktop app — native OAuth libraries, simpler loopback callback, same IdPs most enterprises use today.

## Compliance operations (v1.1+)

Enterprise **Compliance mode** adds retention, signed evidence exports, and audit reconstruction:

| Setting / IPC | Purpose |
|---------------|---------|
| `settings.compliance.enabled` | Master toggle — retention purge skipped when off; legal hold always enforced |
| `settings.compliance.defaultRetentionTtlMs` | Cortex-wide default TTL when an engram has no per-graph override |
| `settings.compliance.defaultExportBeforePurge` | Write export slice before `forgetSource` (default true) |
| `compliance.exportEvidencePack` | Signed JSON pack: op-log, consent, MCP audit, engram hashes, skill runs (redacted) |
| `compliance.runRetention` | `{ dryRun: true \| false }` — manual dry-run or purge |
| `compliance.recallAsOf` | Point-in-time recall preview for `admin-audit` reconstruction |

**Per-engram metadata:** `retentionTtlMs`, `retentionExportBeforePurge`, `industryTags` (`hipaa`, `pci`, `export-controlled`), `legalHold` / source `legalHold`.

**Weekly dry-run:** When compliance is enabled, the sidecar idle hook logs a retention dry-run to Activity every ~7 days — **never** auto-purges without explicit user action.

## Org signing key (v1.2)

Settings → Enterprise SSO → **Org signing key** (optional):

- Generate an Ed25519 keypair scoped to the organization
- **Device signature** (always) — from the install's `device.json` signing key
- **Org signature** (when configured) — second signature on Evidence Packs and op-log compaction checkpoint manifests

Public key is stored in `settings.sso.orgSignPublicKey`; secret is encrypted at rest (`orgSignSecretEnc`). Evidence pack JSON embeds `manifestHash` + `signatures[]`; a detached `.sig.json` is offered on export.

## Related

- [AI access controls](/docs/guides/ai-access-controls)
- [Enterprise](/for/enterprise)
- [Enterprise FAQ](/docs/guides/enterprise-faq)
