#!/usr/bin/env node
/**
 * stripe-create-products.mjs
 *
 * Creates one Stripe Product + Price + Payment Link for every Graphnosis
 * Job Memory Kit, then prints the mapping ready to paste into templates.astro.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-create-products.mjs
 *
 * Dry-run (no Stripe calls, just prints what would be created):
 *   DRY_RUN=1 node scripts/stripe-create-products.mjs
 *
 * First time: install stripe in the repo root:
 *   pnpm add stripe -w
 *
 * The script is idempotent via metadata.pack_id — if you run it twice,
 * it detects existing products by that metadata field and skips creation
 * while still retrieving and printing the existing payment link URLs.
 *
 * After-payment redirect:
 *   Each payment link redirects to https://docs.graphnosis.com/download/{pack-id}
 *   Create that static Astro page per pack before going live.
 */

const SECRET   = process.env.STRIPE_SECRET_KEY;
const DRY_RUN  = process.env.DRY_RUN === '1';
const SUCCESS_BASE = process.env.SUCCESS_BASE ?? 'https://docs.graphnosis.com/download';

if (!SECRET && !DRY_RUN) {
  console.error('Error: set STRIPE_SECRET_KEY=sk_live_... (or sk_test_... for sandbox)');
  console.error('       or run with DRY_RUN=1 to preview without making API calls.');
  process.exit(1);
}

// ── Pack catalogue ────────────────────────────────────────────────────────────
// Mirrors the packs array in apps/docs/src/pages/templates.astro.
const PACKS = [
  // Engineering
  { id: 'software-developer',          name: 'Software Developer Starter Kit',              price: 79  },
  { id: 'devops-sre',                  name: 'DevOps & SRE Starter Kit',                    price: 79  },
  { id: 'data-engineer',               name: 'Data Engineer Starter Kit',                   price: 79  },
  { id: 'ml-ai-engineer',              name: 'ML / AI Engineer Starter Kit',                price: 79  },
  { id: 'security-engineer',           name: 'Security Engineer Starter Kit',               price: 99  },
  { id: 'embedded-systems',            name: 'Embedded Systems Engineer Starter Kit',       price: 79  },
  { id: 'mechanical-engineer',         name: 'Mechanical Engineer Starter Kit',             price: 79  },
  { id: 'electrical-pcb-engineer',     name: 'Electrical / PCB Engineer Starter Kit',      price: 79  },
  { id: 'civil-structural-engineer',   name: 'Civil & Structural Engineer Starter Kit',    price: 99  },
  { id: 'chemical-process-engineer',   name: 'Chemical / Process Engineer Starter Kit',    price: 99  },
  { id: 'systems-engineer',            name: 'Systems Engineer Starter Kit',               price: 99  },
  // Industrial / OT
  { id: 'process-equipment',           name: 'Process & Equipment Starter Kit',             price: 149 },
  { id: 'industrial-quality',          name: 'Industrial Quality & Compliance Starter Kit', price: 149 },
  { id: 'ot-field-technician',         name: 'OT Field Technician Starter Kit',             price: 99  },
  // Agentic AI
  { id: 'research-agent',              name: 'Research Agent Starter Kit',                  price: 99  },
  { id: 'customer-agent',              name: 'Customer & Relationship Agent Starter Kit',   price: 99  },
  { id: 'code-agent',                  name: 'Code Agent Starter Kit',                      price: 99  },
  // Long-Cycle Knowledge
  { id: 'project-history',             name: 'Project History Starter Kit',                 price: 79  },
  { id: 'institutional-memory',        name: 'Institutional Memory Starter Kit',            price: 99  },
  { id: 'rd-longcycle',                name: 'R&D Long-Cycle Starter Kit',                  price: 99  },
  // Healthcare
  { id: 'clinical-session',            name: 'Clinical Session Starter Kit',                price: 79  },
  { id: 'care-coordination',           name: 'Care Coordination Starter Kit',               price: 99  },
  { id: 'clinical-research',           name: 'Clinical Research Starter Kit',               price: 99  },
  // Law (Non-Patent)
  { id: 'matter-client',               name: 'Matter & Client Starter Kit',                 price: 79  },
  { id: 'litigation-support',          name: 'Litigation Support Starter Kit',              price: 99  },
  { id: 'regulatory-compliance-legal', name: 'Regulatory & Compliance Starter Kit',         price: 99  },
  // Specialized IP & Legal
  { id: 'patent-portfolio',            name: 'Patent Portfolio Starter Kit',                price: 99  },
  { id: 'trade-secret',                name: 'Trade Secret Protection Starter Kit',         price: 149 },
  { id: 'ip-due-diligence',            name: 'IP Due Diligence Starter Kit',                price: 99  },
  // Finance & Insurance
  { id: 'investment-research',         name: 'Investment Research Starter Kit',             price: 79  },
  { id: 'risk-underwriting',           name: 'Risk & Underwriting Starter Kit',             price: 99  },
  { id: 'client-portfolio',            name: 'Client Portfolio Starter Kit',                price: 99  },
  // Government & Public Sector
  { id: 'policy-regulation',           name: 'Policy & Regulation Starter Kit',             price: 99  },
  { id: 'records-foia',                name: 'Records & FOIA Starter Kit',                  price: 79  },
  { id: 'grant-program',               name: 'Grant & Program Management Starter Kit',      price: 79  },
  // Defense & Aerospace
  { id: 'itar-compliance',             name: 'ITAR Compliance Starter Kit',                 price: 199 },
  { id: 'defense-contractor',          name: 'Defense Contractor Starter Kit',              price: 149 },
  { id: 'mission-systems',             name: 'Mission Systems Engineering Starter Kit',     price: 149 },
  // Creative IP Protection
  { id: 'manuscript-narrative',        name: 'Manuscript & Narrative Starter Kit',          price: 79  },
  { id: 'design-visual-ip',            name: 'Design & Visual IP Starter Kit',              price: 79  },
  { id: 'music-audio-ip',              name: 'Music & Audio IP Starter Kit',                price: 79  },
  // Journalism & Investigation
  { id: 'source-memory',               name: 'Source Memory Starter Kit',                   price: 79  },
  { id: 'investigation-thread',        name: 'Investigation Thread Starter Kit',            price: 99  },
  // Scientific Research
  { id: 'laboratory-notebook',         name: 'Laboratory Notebook Starter Kit',             price: 79  },
  { id: 'literature-synthesis',        name: 'Literature & Synthesis Starter Kit',          price: 79  },
  { id: 'multi-institution-research',  name: 'Multi-Institution Research Starter Kit',      price: 99  },
  // Education & Knowledge Work
  { id: 'academic-research',           name: 'Academic Research Starter Kit',               price: 79  },
  { id: 'corporate-ld',                name: 'Corporate L&D Starter Kit',                   price: 79  },
  // Field Operations & Trades
  { id: 'field-service',               name: 'Field Service Starter Kit',                   price: 79  },
  { id: 'safety-compliance-field',     name: 'Safety & Compliance Starter Kit',             price: 99  },
  // Architecture & Construction
  { id: 'design-planning',             name: 'Design & Planning Starter Kit',               price: 79  },
  { id: 'construction-project',        name: 'Construction Project Management Starter Kit', price: 79  },
  // Business Operations & B2B
  { id: 'sales-account',               name: 'Sales & Account Starter Kit',                 price: 99  },
  { id: 'customer-success',            name: 'Customer Success Starter Kit',                price: 79  },
  { id: 'vendor-operations',           name: 'Vendor & Operations Starter Kit',             price: 79  },
  // Non-Profits & Communities
  { id: 'nonprofit-foundation',        name: 'Non-Profit & Foundation Starter Kit',         price: 79  },
  { id: 'nonprofit-large-community',   name: 'Large Community & Membership Org Starter Kit', price: 99 },
];

// ── Dry-run path ──────────────────────────────────────────────────────────────

if (DRY_RUN) {
  console.log('\n🔎  DRY RUN — no Stripe calls\n');
  const results = PACKS.map(p => ({
    id: p.id,
    url: `https://buy.stripe.com/DRY_RUN_${p.id}`,
  }));
  printResults(results);
  process.exit(0);
}

// ── Live path ─────────────────────────────────────────────────────────────────

const { default: Stripe } = await import('stripe');
const stripe = new Stripe(SECRET, { apiVersion: '2024-04-10' });

async function findOrCreateProduct(pack) {
  const list = await stripe.products.search({
    query: `metadata['pack_id']:'${pack.id}'`,
    limit: 1,
  });
  if (list.data[0]) {
    console.log(`  ↩  product exists`);
    return list.data[0];
  }
  const product = await stripe.products.create({
    name: pack.name,
    metadata: { pack_id: pack.id },
    description: `Graphnosis Job Memory Kit — ${pack.name}. One-time purchase. Local, private, encrypted.`,
  });
  console.log(`  ✓  product created`);
  return product;
}

async function findOrCreatePrice(product, pack) {
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 10 });
  const existing = prices.data.find(
    p => p.type === 'one_time' && p.unit_amount === pack.price * 100 && p.currency === 'usd'
  );
  if (existing) {
    console.log(`  ↩  price exists    $${pack.price}`);
    return existing;
  }
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: pack.price * 100,
    currency: 'usd',
  });
  console.log(`  ✓  price created   $${pack.price}`);
  return price;
}

async function findOrCreatePaymentLink(price, pack) {
  // Payment links can't be searched by price via the API —
  // create a fresh one each run (idempotent at product/price level is enough).
  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    after_completion: {
      type: 'redirect',
      redirect: { url: `${SUCCESS_BASE}/${pack.id}` },
    },
    metadata: { pack_id: pack.id },
    collect_shipping_address: false,
    billing_address_collection: 'required', // EU VAT requires billing address
    automatic_tax: { enabled: true },       // requires Stripe Tax to be enabled
  });
  console.log(`  ✓  link created    ${link.url}`);
  return link;
}

console.log('\n🚀  Running against Stripe...\n');
const results = [];

for (const pack of PACKS) {
  console.log(`\n── ${pack.name} ($${pack.price})`);
  try {
    const product = await findOrCreateProduct(pack);
    const price   = await findOrCreatePrice(product, pack);
    const link    = await findOrCreatePaymentLink(price, pack);
    results.push({ id: pack.id, url: link.url });
  } catch (err) {
    console.error(`  ✗  FAILED: ${err.message}`);
    results.push({ id: pack.id, url: `ERROR: ${err.message}` });
  }
}

printResults(results);

// ── Output ────────────────────────────────────────────────────────────────────

function printResults(results) {
  console.log('\n\n══════════════════════════════════════════════════════════');
  console.log('  Paste-ready stripeUrl values for templates.astro');
  console.log('══════════════════════════════════════════════════════════\n');
  for (const { id, url } of results) {
    console.log(`  // ${id}`);
    console.log(`  stripeUrl: '${url}',\n`);
  }
  console.log('══════════════════════════════════════════════════════════');
  console.log(`\nDone. ${results.length} packs processed.\n`);
}
