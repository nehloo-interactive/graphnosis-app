---
title: Terms of Use
description: The terms governing your use of Graphnosis and what Nehloo Interactive is and isn't responsible for.
---

*Last updated: May 2026*
*Effective date: May 2026*

Please read these Terms of Use carefully before using Graphnosis. By downloading, installing, or using Graphnosis, you agree to be bound by these terms. If you do not agree, do not use the software.

---

## 1. Agreement to terms

These Terms of Use ("Terms") are a legal agreement between you ("you," "User") and **Nehloo Interactive LLC**, a limited liability company ("Nehloo Interactive," "we," "us," or "our"). These Terms govern your use of the Graphnosis desktop application, any accompanying documentation, and any related services (collectively, the "Software").

---

## 2. License

### 2.1 Grant of license

Subject to these Terms, Nehloo Interactive grants you a limited, non-exclusive, non-transferable, revocable license to use the Software for your personal, non-commercial purposes, strictly in accordance with these Terms and the Software's license file.

### 2.2 Source license

Graphnosis is released under the **Functional Source License, Version 1.1 (FSL-1.1-Apache-2.0)**. Under this license:
- You may read, audit, fork, modify, and self-host the source code.
- You may **not** offer Graphnosis (or a substantially similar product derived from it) as a commercial hosted or managed service during the two-year exclusivity window following each release.
- Each release converts automatically to Apache 2.0 two years after its release date.

The embedded `@nehloo/graphnosis` SDK is separately licensed under Apache 2.0 and is not subject to the above restriction.

### 2.3 Restrictions

You agree not to:
- Remove or alter any proprietary notices or labels on the Software.
- Use the Software to develop a competing commercial service in violation of the FSL-1.1 license.
- Reverse-engineer any portions of the Software for purposes not permitted by the license.
- Use the Software to ingest, store, process, or recall content that you do not have the right to use.

### 2.4 Trademarks

Graphnosis™, the Graphnosis logo, and "Nehloo Interactive" are trademarks of Nehloo Interactive LLC. The source license (FSL-1.1) grants you rights in the **source code**; it does not grant any right to use these names or logos in a way likely to cause confusion, to suggest endorsement by or affiliation with Nehloo Interactive, or to name a forked or derivative product. Nominative use — truthfully stating that your project is built on, compatible with, or derived from Graphnosis — is permitted.

---

## 3. Early access and alpha status

**Graphnosis is currently in private alpha.** The Software is provided for evaluation purposes. Features may change, be removed, or behave unexpectedly. Data formats may change between versions in ways that require migration or cause data loss.

**You are strongly advised to maintain independent backups of any content you ingest into Graphnosis.** Do not rely on Graphnosis as your sole copy of important data.

---

## 4. Your responsibilities

### 4.1 Your cortex data

You are solely responsible for:
- All content you ingest into your cortex.
- Ensuring you have the rights to ingest and process that content.
- Maintaining backups of your cortex folder.
- The security of your device, passphrase, and recovery phrase.

### 4.2 Passphrase and recovery phrase

Graphnosis encrypts your cortex with a key derived from your passphrase. Nehloo Interactive does not store your passphrase, recovery phrase, or encryption key. **If you lose both your passphrase and your 24-word recovery phrase, your data is permanently unrecoverable.** Nehloo Interactive cannot restore it. Safeguard your recovery phrase accordingly.

### 4.3 Third-party AI clients and the consent gate

Graphnosis is designed to work with third-party AI clients (e.g., Claude Desktop by Anthropic, ChatGPT by OpenAI, Cursor, and others) via the Model Context Protocol (MCP). When you connect Graphnosis to such a client:

- **You are responsible for your relationship with that AI provider**, including reviewing and accepting their terms of service and privacy policy.
- Recalled memory snippets sent to those AI clients are processed under those providers' terms, **not under these Terms or Nehloo Interactive's Privacy Policy**.
- Nehloo Interactive is not responsible for how any AI provider processes, uses, retains, or discloses information you share through their service.
- You acknowledge that AI-generated responses may be inaccurate, incomplete, or misleading regardless of the memory context provided.

**Informed consent via the consent gate**: When you authorize an AI client to read a sensitive-tier engram — either by clicking an Allow button on the in-app consent modal that pops in the Graphnosis app, or by typing the time-limited consent phrase into the AI conversation in headless setups — you are explicitly and personally authorizing the transmission of that memory content to the named AI provider. For `personal`-tier engrams, your decision to install Graphnosis and add it to your AI client's MCP configuration constitutes the informed consent for routine access (or, when "Extra precaution mode" is on in Settings → AI, the same per-recall authorization applies). This authorization is yours — not Graphnosis's and not the AI's. Nehloo Interactive does not receive, transmit, see, store, or log the transmitted memory content and has no technical ability to access your cortex or the data you choose to share with AI providers. The complete description of the consent gate, the in-app modal flow, per-client policies, configurable intervals, rate limit, session replay blocker, and optional session caps lives in [AI Access Controls](/guides/ai-access-controls).

You acknowledge that the AI provider's privacy policy and terms of service govern their handling of your data, and that Nehloo is not a party to your agreement with the AI provider.

### 4.4 Consent records

Graphnosis stores consent records locally in your encrypted cortex, as immutable audit nodes. Each record contains: timestamp, AI client name, data tier, and consent interval — never memory content, never the consent phrase itself. These records exist on your device only. Nehloo cannot access, produce, or delete them. You can view, export, and revoke consent records in the Graphnosis app (Settings → AI → Data). You are responsible for maintaining your cortex backup, which includes your consent history.

### 4.5 Acceptable use

You agree not to use the Software to:
- Ingest, store, or process content that infringes any third party's intellectual property rights.
- Ingest, store, or process illegal content, including but not limited to content that violates privacy laws, export control laws, or laws governing the rights of third parties.
- Circumvent or attack any security mechanism.
- Facilitate harassment, abuse, or unlawful discrimination.

---

### 4.6 Nehloo's role

**Nehloo Interactive is the developer and distributor of Graphnosis software. Nehloo is not a data controller or processor for data you store in your cortex or share with AI providers.** You are the controller of your own cortex data. Nehloo does not hold, process, or have access to your cortex data in any form. For data Nehloo does hold (your account email and newsletter subscription), Nehloo acts as data controller and complies with applicable law.

### 4.7 Use of the latest version

The consent and privacy protections described in these Terms apply to current and recent releases of Graphnosis. Older versions released before **v0.10** do not include the Layer 4 consent mechanism described in §4.3. Nehloo strongly recommends updating to the latest release. Nehloo is not liable for privacy outcomes arising from use of outdated software versions.

---

## 5. Disclaimer of warranties

**THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.**

TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, NEHLOO INTERACTIVE EXPRESSLY DISCLAIMS ALL WARRANTIES, INCLUDING BUT NOT LIMITED TO:

- WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT;
- WARRANTIES THAT THE SOFTWARE WILL MEET YOUR REQUIREMENTS OR OPERATE WITHOUT INTERRUPTION OR ERROR;
- WARRANTIES REGARDING THE ACCURACY, COMPLETENESS, OR RELIABILITY OF ANY INFORMATION RECALLED FROM YOUR CORTEX OR AS PRESENTED BY ANY AI CLIENT THAT CONSUMES SUCH INFORMATION;
- WARRANTIES REGARDING THE SECURITY OF YOUR DATA AGAINST THREATS BEYOND OUR CONTROL (DEVICE COMPROMISE, CLOUD STORAGE PROVIDER BREACH, ETC.).

No oral or written information or advice given by Nehloo Interactive shall create any warranty not expressly stated in these Terms.

---

## 6. Limitation of liability

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW:**

**NEHLOO INTERACTIVE, ITS OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, AFFILIATES, LICENSORS, AND SERVICE PROVIDERS SHALL NOT BE LIABLE FOR ANY:**

- **INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES;**
- **LOSS OF PROFITS, REVENUE, DATA, BUSINESS, OR GOODWILL;**
- **COST OF SUBSTITUTE GOODS OR SERVICES;**
- **DAMAGES ARISING FROM YOUR USE OF, OR INABILITY TO USE, THE SOFTWARE, INCLUDING ANY DECISIONS MADE IN RELIANCE ON AI RESPONSES INFORMED BY RECALLED MEMORY CONTEXT;**
- **DAMAGES ARISING FROM LOSS OR CORRUPTION OF YOUR CORTEX DATA, REGARDLESS OF CAUSE.**

**IN NO EVENT SHALL NEHLOO INTERACTIVE'S TOTAL LIABILITY TO YOU FOR ALL CLAIMS ARISING UNDER OR RELATED TO THESE TERMS EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID FOR THE SOFTWARE IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM, OR (B) FIFTY U.S. DOLLARS ($50).**

Some jurisdictions do not allow the exclusion or limitation of incidental or consequential damages. In such jurisdictions, the above limitations apply to the fullest extent permitted by law.

---

## 7. Indemnification

You agree to defend, indemnify, and hold harmless Nehloo Interactive and its officers, directors, employees, agents, and affiliates from and against any claims, liabilities, damages, judgments, awards, losses, costs, expenses, or fees (including reasonable attorneys' fees) arising out of or relating to:

- Your use of the Software in violation of these Terms;
- Your ingestion of content you do not have the right to use;
- Your connection of Graphnosis to third-party AI clients and any consequences thereof;
- Your violation of any applicable law or regulation;
- Any claim that your use of the Software harmed a third party.

---

## 8. Third-party services and components

### 8.1 Embedded open-source components

The Software incorporates open-source libraries. Their licenses are included in the Software distribution. Nehloo Interactive makes no representations regarding those libraries beyond what their respective licenses require.

### 8.2 AI clients

Graphnosis is compatible with third-party AI clients but has no affiliation with Anthropic, OpenAI, Microsoft, or any other AI provider. Use of those services is governed entirely by their own terms. Nehloo Interactive is not responsible for changes those providers make to their APIs, policies, or models.

### 8.3 Cloud storage providers

If you choose to store your cortex on a cloud service (iCloud, Dropbox, Google Drive, etc.), your use of that service is governed by that service's terms. Nehloo Interactive is not affiliated with any such provider.

### 8.4 Ollama and local LLMs

Several optional features — AI-generated insights, the synthesised `develop` / `predict` output, and the LLM-assisted correction path — can use a local large language model run via Ollama, a separate third-party application. These features are off by default, and Ollama is never required: the core app, including the deterministic `correct` flow, works fully without it. Your use of Ollama and any models you download is governed by Ollama's terms and the respective model licenses. Nehloo Interactive does not distribute Ollama or any LLM weights.

---

## 9. Privacy

Our Privacy Policy, available at [/legal/privacy-policy](/legal/privacy-policy), is incorporated into these Terms by reference. By using the Software, you acknowledge that you have read and understood the Privacy Policy.

---

## 10. Updates and modifications to the software

We may release updates to the Software. Updates may change functionality, data formats, or system requirements. We have no obligation to provide updates, maintain backward compatibility, or support older versions. We recommend keeping the Software updated and maintaining independent backups before applying any update.

---

## 11. Termination

These Terms are effective until terminated. Your rights under these Terms terminate automatically without notice if you fail to comply with any term. Upon termination, you must stop using the Software and destroy all copies in your possession. Sections 5, 6, 7, 12, and 13 survive termination.

---

## 12. Governing law and dispute resolution

These Terms are governed by the laws of the **State of Indiana**, without regard to its conflict of law provisions.

**Any dispute arising under or related to these Terms shall be resolved by binding arbitration** administered by the American Arbitration Association (AAA) under its Consumer Arbitration Rules, except that either party may seek injunctive or other equitable relief in any court of competent jurisdiction for violations of intellectual property rights.

**CLASS ACTION WAIVER:** You agree to resolve any disputes with us on an individual basis and waive any right to participate in a class action lawsuit or class-wide arbitration.

If any provision of this arbitration clause is found unenforceable, the remaining provisions shall remain in full effect, and disputes shall be resolved in the state or federal courts located in Indiana.

---

## 13. General provisions

**Entire agreement.** These Terms, together with the Privacy Policy and the Software license, constitute the entire agreement between you and Nehloo Interactive regarding the Software and supersede all prior agreements.

**Severability.** If any provision of these Terms is held invalid or unenforceable, that provision will be enforced to the maximum extent permissible, and the other provisions will remain in full force.

**No waiver.** Failure to enforce any provision of these Terms does not constitute a waiver of our right to enforce it in the future.

**Assignment.** You may not assign your rights under these Terms without our prior written consent. We may assign our rights without restriction.

**Force majeure.** Nehloo Interactive is not liable for any failure or delay in performance due to causes beyond our reasonable control.

---

## 14. Changes to these terms

We reserve the right to modify these Terms at any time. When we make material changes, we will update the "Last updated" date and note the changes in the release notes accompanying app updates. Your continued use of the Software after any modification constitutes acceptance of the revised Terms.

---

## 15. Contact

**Nehloo Interactive LLC**
Email: legal@graphnosis.com
Website: https://graphnosis.com

---

*These Terms have been drafted to be protective of Nehloo Interactive's interests. They do not constitute legal advice and should be reviewed by a licensed attorney in your jurisdiction before publication, particularly regarding the arbitration clause, class action waiver, and jurisdiction provisions, which vary in enforceability by location.*
