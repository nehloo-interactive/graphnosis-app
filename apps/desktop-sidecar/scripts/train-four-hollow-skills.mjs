/**
 * One-shot retrain for 4 hollow business skills on live cortex.
 * Usage:
 *   GRAPHNOSIS_CORTEX=/Users/nelulazar/Graphnosis-test node apps/desktop-sidecar/scripts/train-four-hollow-skills.mjs
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CORTEX = process.env.GRAPHNOSIS_CORTEX ?? path.join(os.homedir(), 'Graphnosis-test');
const SOCKET = process.env.GRAPHNOSIS_IPC_SOCKET ?? path.join(CORTEX, 'sidecar.sock');
const GRAPH_ID = process.env.GRAPHNOSIS_SKILLS_GRAPH ?? 'graphnosis-skills';

const SKILLS = [
  {
    name: 'go-to-market-planning',
    sourceId: 'skill:74a3c03be8a8c417c0ba45f4',
    skill: `go-to-market-planning

Go-To-Market Planning — Launch Phases, ICP, Channels, and Metrics

Trigger: GTM question, launch planning, pricing tier decision, channel strategy, or "how do we go to market". Before major launch or repositioning. [dispatch-safe: yes]

Prerequisites: Product has a defined core value proposition (even if draft). Stakeholder available for ICP and pricing assumptions.

Requires: $launchScope:{new-product|tier-expansion|reposition|channel-test}, $motion:{self-serve|sales-led|hybrid}?

Produces: $gtmBrief, $icpSummary, $channelPlan, $metricsFramework

Success: Written GTM brief with ICP, messaging, channel mix, launch phases, and success metrics. Decisions saved to go-to-market engram. Nelu can execute or delegate the first 30 days. [verify: human]

Out of scope: Legal contract drafting (→ legal-review-checklist). Enterprise deal execution (→ enterprise-sales-prep). Implementation work in codebase.

On failure: If recall returns sparse GTM history, interview Nelu for current assumptions; save immediately before proceeding.

On completion: GTM brief remembered in graphnosis-go-to-market with date, scope, and open questions.

1. Call recall("go-to-market pricing tier ICP channels launch positioning",
   only_engrams=["graphnosis-go-to-market", "graphnosis-business-strategy"]).
   Surface prior tier decisions, channel experiments, and positioning notes.

2. Frame the launch scope: What is shipping or changing? Is this net-new, tier expansion,
   reposition, or a channel test? Document $launchScope in one paragraph.

3. Define Ideal Customer Profile (ICP):
   - Primary buyer persona (title, company size, industry)
   - Job-to-be-done and acute pain
   - Anti-personas (who this is NOT for)
   - Self-serve vs sales-led fit for this ICP

4. Choose go-to-market motion ($motion):
   - Self-serve: product-led, freemium/trial, in-app conversion, docs/community
   - Sales-led: outbound, demos, pilots, security review, procurement
   - Hybrid: self-serve entry with sales assist at expansion
   @branch: If regulated industry or >$10k ACV expected → bias sales-led; note @skill: enterprise-gtm-compliance-angle

5. Messaging architecture:
   - One-line positioning (who + outcome + differentiator)
   - Three proof points (features → outcomes, not feature lists)
   - Objection map: top 3 buyer fears and honest responses
   - Enterprise vs individual messaging split if hybrid

6. Channel plan (pick 2 primary, 1 experimental for first 90 days):
   - Owned: website, docs, email, in-product
   - Earned: community, content, press, word-of-mouth
   - Paid: search, social, events (budget and kill threshold)
   - Partner: integrations, resellers, co-marketing
   For each channel: owner, first action, cost, success signal.

7. Launch phases:
   - Phase 0 (pre-launch): dogfood, beta list, compliance/legal review if needed
   - Phase 1 (soft launch): limited audience, feedback loop, fix blockers
   - Phase 2 (general availability): full channels live, support ready
   - Phase 3 (optimize): double down on winning channel, cut losers

8. Metrics framework — define before launch, not after:
   - North star metric for this launch
   - Leading indicators (signups, activations, demos booked)
   - Lagging indicators (revenue, retention, expansion)
   - Kill criteria: what signal in 30/60/90 days means pivot or stop

9. Competitive and category check: recall("competitor alternative positioning market").
   Where do we win honestly? Where do we defer or partner?

10. Synthesize $gtmBrief (1–2 pages): ICP, motion, messaging, channels, phases, metrics.
    Flag dependencies: legal review, enterprise security pack, docs updates.

11. Call remember: "GTM plan <date> — $launchScope / $motion: [ICP one-liner, channels, north star, kill criteria]."
    Target: graphnosis-go-to-market.

12. If enterprise motion: propose pairing with @skill: enterprise-sales-prep for first target accounts.`,
  },
  {
    name: 'legal-review-checklist',
    sourceId: 'skill:27cba4cd0ccd1161fd621248',
    skill: `legal-review-checklist

Legal Review Checklist — Terms, Privacy, OSS, Enterprise Contracts, Compliance Claims

Trigger: Legal document review, NDA, terms of service update, privacy policy change, enterprise contract redlines, OSS license audit, or compliance marketing claim. [dispatch-safe: yes]

Prerequisites: Draft document or specific clause identified. Know whether change is user-facing, enterprise-only, or internal.

Requires: $docType:{terms|privacy|nda|enterprise-msa|dpa|oss-audit|marketing-claim|other}, $jurisdiction:{us|eu|global}?

Produces: $reviewFindings, $riskTier, $recommendedActions

Success: Structured review memo with risk tier per finding, honest compliance posture, and clear next actions (legal counsel vs self-serve fix). No overclaimed certifications. [verify: human]

Out of scope: Providing legal advice — this skill organizes review and flags risks; licensed counsel decides. Filing patents or trademarks (separate workflow).

On failure: If document is missing, request the draft or URL before proceeding. Never invent contract language.

On completion: Summary remembered in graphnosis-legal; compliance-impacting findings also saved to graphnosis-compliance.

1. Call recall("$docType legal terms privacy compliance commitments",
   only_engrams=["graphnosis-legal", "graphnosis-compliance", "graphnosis-decisions"]).
   Surface prior commitments, NDAs, and known certification status.

2. Classify $docType and audience:
   - Consumer (ToS, Privacy Policy)
   - Enterprise (MSA, DPA, BAA request, security exhibit)
   - Partner (NDA, integration agreement)
   - Open source (license compatibility, NOTICE file)
   - Marketing (HIPAA-ready, SOC 2, GDPR compliant claims)

3. Terms of Service / EULA checklist:
   - Acceptable use, termination, limitation of liability, warranty disclaimer
   - Subscription/billing terms match actual product behavior
   - Arbitration/governing law appropriate for $jurisdiction
   - AI-specific clauses: output ownership, training data, third-party model use

4. Privacy Policy checklist:
   - Data collected vs actually collected (audit the product)
   - Local-first / on-device processing described accurately
   - Subprocessors list current and complete
   - User rights (access, deletion, export) match product capabilities
   - Cookie/analytics disclosure if any telemetry exists
   - Cross-border transfer mechanisms if applicable (SCCs, etc.)

5. Enterprise contract checklist (MSA/DPA):
   - Data processing roles (controller/processor) accurate
   - Security exhibit matches real controls — no aspirational claims
   - SLA and support terms achievable
   - Liability caps, indemnification, insurance requirements
   - Audit rights: can we satisfy without exposing other customers' data?
   - BAA/HIPAA: only commit if BAA program exists; else honest deferral

6. OSS license audit:
   - Inventory dependencies with copyleft implications (GPL, AGPL)
   - Attribution and NOTICE requirements for distributed binaries
   - License conflicts between app license and dependencies
   - SaaS vs on-prem distribution differences

7. Compliance marketing claims — honesty gate:
   - SOC 2: Type I vs Type II; in-progress vs certified — never conflate
   - HIPAA: "HIPAA-ready architecture" ≠ "HIPAA compliant" unless BAA + program
   - GDPR: lawful basis, DPA availability, DSR process documented
   - FedRAMP/FIPS: only claim if authorized or explicitly on roadmap with date
   Flag any claim that exceeds attested status → $riskTier: high

8. NDA review (mutual or one-way):
   - Definition of confidential information not overbroad
   - Term and survival period reasonable
   - Carve-outs for independently developed IP
   - Residuals clause if acceptable to business

9. Assign $riskTier per finding: low (wordsmith), medium (product change needed), high (counsel required / block ship).

10. Draft $reviewFindings as numbered list: finding, risk, recommendation, owner.

11. Call remember: "Legal review <date> — $docType: [top findings, risk tier, open questions]."
    Target: graphnosis-legal. If compliance posture affected → also graphnosis-compliance.

12. If ship-blocking high-risk items: surface to Nelu before any public release or enterprise signature.`,
  },
  {
    name: 'product-ideation',
    sourceId: 'skill:b10ac80b035f1b8be04bcf22',
    skill: `product-ideation

Product Ideation — Problem Framing, Interviews, MVP Scope, and Kill Criteria

Trigger: New product idea, feature brainstorm, "should we build X", spike/prototype decision, or prioritizing ideas from backlog. [dispatch-safe: yes]

Prerequisites: Idea stated in one sentence or problem observed. Willingness to kill weak ideas early.

Requires: $ideaSeed:string, $urgency:{explore|validate|build}?

Produces: $problemStatement, $mvpScope, $validationPlan, $killCriteria

Success: Idea captured with problem statement, target user, MVP boundary, validation plan, and explicit kill criteria. Weak ideas killed or parked with reason. Strong ideas promoted to graphnosis-ideas with next step. [verify: human]

Out of scope: Full implementation — route to vibe-coding-workflow or coding skills after validation. GTM launch planning (→ go-to-market-planning).

On failure: If idea is too vague, run a 5-minute structured interview with Nelu before proceeding.

On completion: Idea card saved to graphnosis-ideas; strategic fit noted in graphnosis-business-strategy if material.

1. Call recall("$ideaSeed feature idea experiment user pain",
   only_engrams=["graphnosis-ideas", "graphnosis-business-strategy", "coding"]).
   Check for duplicates, prior attempts, and related decisions.

2. Problem framing (not solution framing):
   - Who has this problem? (specific persona, not "everyone")
   - How do they solve it today? (status quo, workarounds, competitors)
   - Why now? (trigger, urgency, market shift)
   - What happens if we do nothing?
   Write $problemStatement in ≤100 words.

3. Idea vs project gate:
   - Is anyone actively suffering this today?
   - Is there a path to first value in ≤2 weeks of effort?
   - Does it align with stated product strategy?
   @branch: If no to all three → park idea with reason; stop unless Nelu overrides.

4. Memory-augmented product patterns (when relevant):
   - Does this feature leverage persistent user memory / context across sessions?
   - Privacy model: local-first, consent tiers, export/portability
   - Agent workflow: recall at walk-time vs bake at train-time
   Note which patterns apply even for non-memory products.

5. User interview plan (minimum 3 conversations before build):
   - Interview script: 5 open questions, no pitching
   - Recruitment: where to find target users this week
   - Success signal: what answer would validate vs invalidate

6. Define $mvpScope — smallest slice that tests the core hypothesis:
   - In scope: one workflow, one persona, one success metric
   - Out of scope: polish, edge cases, secondary personas
   - Time box: calendar deadline for spike or prototype

7. $validationPlan:
   - Hypothesis: "We believe [persona] will [behavior] because [reason]"
   - Experiment: prototype, concierge, landing page, or wizard-of-oz
   - Metric: qualitative threshold or numeric target
   - Duration: days, not months

8. $killCriteria — write before building:
   - If fewer than N interviews show the pain → kill
   - If activation metric below X after launch → kill or pivot
   - If strategic fit conflicts with attested roadmap decision → defer
   Pre-commit to avoid sunk-cost continuation.

9. Competitive/alternative scan: recall("competitor alternative $ideaSeed").
   Build vs buy vs integrate vs ignore?

10. Risk and compliance pre-check:
    @branch: If idea touches regulated data, enterprise sales, or legal commitments →
    flag @skill: legal-review-checklist and @skill: feature-impact-assessment before build.

11. Synthesize idea card: problem, persona, MVP, validation plan, kill criteria, next action.

12. Call remember: "Idea <date> — $ideaSeed: [problem, MVP one-liner, validation next step, kill criteria]."
    Target: graphnosis-ideas.`,
  },
  {
    name: 'enterprise-sales-prep',
    sourceId: 'skill:d798c07e5bc581c2922c681d',
    skill: `enterprise-sales-prep

Enterprise Sales Prep — Discovery, Security Review, IT FAQ, Pilot, and Procurement

Trigger: Enterprise prospect identified, demo scheduled, security questionnaire received, pilot proposed, or procurement process starting. [dispatch-safe: yes]

Prerequisites: Prospect name and industry known (even roughly). Product has enterprise-relevant capabilities documented.

Requires: $prospectContext:string, $stage:{discovery|demo|security-review|pilot|procurement}?

Produces: $discoveryNotes, $securityResponses, $pilotProposal, $procurementTimeline

Success: Nelu enters the meeting with discovery questions, honest security answers, pilot structure, and procurement timeline expectations. Commitments logged to decisions engram. [verify: human]

Out of scope: Signing contracts (→ legal-review-checklist). Full GTM strategy (→ go-to-market-planning). Custom engineering without feature-impact assessment.

On failure: If product lacks a requested enterprise capability, document gap honestly — never promise on roadmap without decision engram entry.

On completion: Deal notes in graphnosis-customer-support or graphnosis-go-to-market; commitments in graphnosis-decisions.

1. Call recall("$prospectContext enterprise prospect deal security requirements",
   only_engrams=["graphnosis-customer-support", "graphnosis-go-to-market", "graphnosis-compliance"]).
   Surface prior interactions, FAQ patterns, and industry-specific notes.

2. Discovery framework ($stage = discovery):
   - Business pain: what triggered the search now?
   - Current stack: what tools, what failed?
   - Buyers: economic buyer, technical evaluator, end users, blockers
   - Success criteria: what does a win look like in 90 days?
   - Budget and timeline: fiscal year, procurement cycle hints
   Capture in $discoveryNotes.

3. IT and security FAQ prep:
   - Deployment model: local app, sidecar, cloud components (be precise)
   - Data residency: where data lives, what never leaves device
   - Encryption: at rest, in transit, key management
   - Authentication: SSO/SAML status (available vs roadmap)
   - Audit: activity log, evidence export, MCP audit trail
   - Subprocessors and AI models: what touches third parties
   Recall prior security-review findings from coding engram if any.

4. Security questionnaire workflow ($stage = security-review):
   - Triage questions: blockers vs nice-to-have
   - Map each question to documented control or honest gap
   - Never copy boilerplate that overclaims certification
   - Escalate novel questions to @skill: security-review-cadence if product change implied
   Draft $securityResponses with owner per open item.

5. Regulated industry angle:
   @skill: enterprise-gtm-compliance-angle(targetIndustry=$industryFromContext)
   Integrate industry-specific compliance story into pitch.

6. Demo structure (30 minutes):
   - Minutes 0–5: their pain reflected back
   - Minutes 5–20: workflow demo on their use case (not feature tour)
   - Minutes 20–25: security/trust architecture for their IT concerns
   - Minutes 25–30: clear next step (pilot, security pack, intro to legal)

7. Pilot proposal ($stage = pilot):
   - Scope: users, engrams, integrations, duration (4–8 weeks typical)
   - Success metrics agreed upfront with champion
   - Support model: who they call, SLA expectations
   - Exit: convert, extend, or end — no infinite pilot
   - Data handling at pilot end: export, deletion, retention
   Write $pilotProposal one page.

8. Procurement timeline ($stage = procurement):
   - Typical enterprise phases: security → legal → PO → implementation
   - Week-by-week realistic estimate; flag holiday/fiscal-year effects
   - Documents likely needed: MSA, DPA, security exhibit, W-9, insurance cert
   - Identify blockers early (vendor onboarding portal, infosec committee cadence)

9. Objection handling — top enterprise blockers:
   - "We can't use cloud AI with our data" → local-first architecture story
   - "We need SSO" → current status and timeline
   - "We need SOC 2" → accurate certification status
   - "Build vs buy" → time-to-value and total cost of ownership framing

10. Commitment discipline: any promise to prospect → remember in graphnosis-decisions
    with date, owner, and delivery expectation. Never verbal-only enterprise commitments.

11. Call remember: "Enterprise prep <date> — $prospectContext / $stage: [key discovery, open security items, next meeting action]."
    Target: graphnosis-go-to-market.

12. After pilot or closed-won: route learnings to @skill: user-feedback-ingestion and update FAQ patterns.`,
  },
];

let nextId = 1;

function ipcCall(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const payload = JSON.stringify({ id, method, params }) + '\n';
    const socket = net.connect(SOCKET);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === id) {
          socket.destroy();
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      }
    });
    socket.on('error', reject);
    socket.setTimeout(180_000, () => {
      socket.destroy();
      reject(new Error(`IPC timeout for ${method}`));
    });
  });
}

async function getMetrics(sourceId) {
  const detail = await ipcCall('skill:get', { graphId: GRAPH_ID, sourceId });
  const walk = await ipcCall('skill:walkSequence', {
    graphId: GRAPH_ID,
    sourceId,
    recursive: false,
  });
  return {
    nodeCount: detail?.nodeCount ?? 0,
    walkSteps: (walk?.steps ?? []).length,
    mode: detail?.mode,
  };
}

async function main() {
  console.log(`Training ${SKILLS.length} skills via ${SOCKET}`);
  const results = [];

  for (const { name, sourceId, skill } of SKILLS) {
    const before = await getMetrics(sourceId);
    console.log(`\n--- ${name} --- before: nodes=${before.nodeCount} walk=${before.walkSteps}`);

    try {
      const trainResult = await ipcCall('skill:train', {
        skill,
        graphId: GRAPH_ID,
        skillName: name,
        save: true,
        useLlmRewrite: false,
      });

      if (trainResult?.upgrade_required) {
        results.push({ name, sourceId, ...before, action: 'fail', reason: 'upgrade_required' });
        console.error(`FAIL ${name}: upgrade_required`);
        continue;
      }

      const after = await getMetrics(sourceId);
      const ok = after.walkSteps > 0 && after.nodeCount > 0;
      results.push({
        name,
        sourceId,
        beforeNodes: before.nodeCount,
        afterNodes: after.nodeCount,
        beforeWalk: before.walkSteps,
        afterWalk: after.walkSteps,
        mode: trainResult?.mode,
        action: ok ? 'retrained' : 'retrain-partial',
      });
      console.log(
        `${ok ? 'OK' : 'PARTIAL'} ${name}: nodes ${before.nodeCount}→${after.nodeCount}, walk ${before.walkSteps}→${after.walkSteps}, mode=${trainResult?.mode}`,
      );
    } catch (err) {
      results.push({
        name,
        sourceId,
        ...before,
        action: 'fail',
        reason: String(err.message ?? err),
      });
      console.error(`FAIL ${name}:`, err.message ?? err);
    }
  }

  console.log('\n=== RESULTS ===');
  console.log(JSON.stringify(results, null, 2));

  const failed = results.filter((r) => r.action === 'fail' || r.action === 'retrain-partial');
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
