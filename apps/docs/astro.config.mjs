import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  // Astro 5: `output: 'static'` now implies hybrid — pages prerender by
  // default, individual routes opt out with `export const prerender = false`.
  // Only the billing endpoints under /upgrade, /claim, /api/* run server-side
  // on the Cloudflare Worker; every Starlight docs page stays statically
  // generated and is served directly by Pages.
  output: 'static',
  redirects: {
    '/consumer': '/',
  },
  // Cloudflare Pages / Workers adapter. `imageService: 'compile'` keeps
  // Sharp out of the worker bundle (the docs pages that use it are
  // prerendered at build time, so the runtime never needs it).
  adapter: cloudflare({
    imageService: 'compile',
    // NOTE on /packs/*: the .gsk files live in public/packs-data/ (NOT
    // public/packs/) precisely so the adapter's auto-exclude of public/
    // files doesn't shadow the counting route src/pages/packs/[pack].ts.
    // With no static files under /packs/, that route is auto-included in
    // _routes.json like any other server route and every download is
    // counted. Do NOT move the files back under public/packs/ — forcing the
    // path back into the Worker via routes.extend.include makes the adapter
    // enumerate all 95 .gsk files as individual excludes (which win over
    // includes) and blows past the 100-rule _routes.json budget.
  }),
  site: 'https://docs.graphnosis.com',
  integrations: [
    starlight({
      title: 'Graphnosis',
      logo: {
        src: './src/assets/graphnosis-logo.png',
        alt: 'Graphnosis',
      },
      favicon: '/graphnosis-logo-rounded.png',
      description: 'The hippocampus your AI has always been missing.',
      tagline: 'The hippocampus your AI has always been missing.',

      customCss: ['./src/styles/custom.css'],
      components: {
        Footer: './src/components/StarlightFooter.astro',
        Sidebar: './src/components/StarlightSidebar.astro',
        // Wraps the default SocialIcons (the GitHub mark in the top
        // header) with a "Download vX.Y.Z" pill rendered to its LEFT.
        // Version is read from apps/desktop/src-tauri/tauri.conf.json
        // at build time so docs always advertise the actual shipped
        // binary version.
        SocialIcons: './src/components/StarlightSocialIcons.astro',
      },
      social: {
        github: 'https://github.com/nehloo-interactive/graphnosis-app',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Overview', slug: 'getting-started/overview' },
            { label: 'Install & First Cortex', slug: 'getting-started/first-cortex' },
            { label: 'Connect Your AI', slug: 'getting-started/connect-ai' },
            { label: 'A GRAPHNOSIS.md for Your AI', slug: 'getting-started/graphnosis-md' },
            { label: 'Connect from Your Phone', slug: 'getting-started/mobile' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Memory Across AI Clients', slug: 'guides/memory-across-ai-clients' },
            { label: 'MCP Tools', slug: 'reference/mcp-tools' },
            { label: 'Skills as SOPs', slug: 'reference/skills' },
            { label: 'Auto-ingest from Your Tools', slug: 'guides/connectors' },
            { label: 'Connect Offline Sources', slug: 'guides/connect-offline-sources' },
            { label: 'Adding Content', slug: 'guides/adding-content' },
            { label: 'Correcting Memories', slug: 'guides/correcting-memories' },
            { label: 'Indelibility & Determinism', slug: 'guides/indelibility-and-determinism' },
            { label: 'Deterministic Consolidation', slug: 'guides/deterministic-consolidation' },
            { label: 'Graphs & Sensitivity Tiers', slug: 'guides/graphs-and-tiers' },
            { label: 'AI Access Controls', slug: 'guides/ai-access-controls' },
            { label: 'Engram Sharing', slug: 'guides/engram-sharing' },
            { label: 'Boot & Engram Loading', slug: 'guides/boot-and-engram-loading' },
            { label: 'Keeping Your Cortex Safe', slug: 'guides/keeping-your-cortex-safe' },
            { label: 'Recovery', slug: 'guides/recovery' },
            { label: 'What Leaves Your Device', slug: 'guides/network-activity' },
            { label: 'Verify It Yourself', slug: 'guides/verify-it-yourself' },
            { label: 'Enterprise IT FAQ', slug: 'guides/enterprise-faq' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Federated Multi-Graphs', slug: 'reference/federated-multi-graphs' },
            { label: 'File Formats', slug: 'reference/file-formats' },
            { label: 'The Story of Ghampus', slug: 'reference/ghampus' },
            { label: 'Environment Variables', slug: 'reference/environment-variables' },
          ],
        },
        {
          label: 'Legal',
          items: [
            { label: 'Privacy Policy', slug: 'legal/privacy-policy' },
            { label: 'Terms of Use', slug: 'legal/terms-of-use' },
            { label: 'Using with AI Clients', slug: 'legal/third-party-ai' },
          ],
        },
        { label: 'Changelog', slug: 'changelog' },
      ],
    }),
    tailwind({ applyBaseStyles: false }),
  ],
});
