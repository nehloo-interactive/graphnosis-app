import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  output: 'static',
  site: 'https://docs.graphnosis.com',
  integrations: [
    starlight({
      title: 'Graphnosis',
      logo: {
        src: './src/assets/graphnosis-logo.png',
        alt: 'Graphnosis',
      },
      description: 'The hippocampus your AI has always been missing.',
      tagline: 'The hippocampus your AI has always been missing.',

      customCss: ['./src/styles/custom.css'],
      social: {
        github: 'https://github.com/nehloo/Graphnosis',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Overview', slug: 'getting-started/overview' },
            { label: 'Install & First Cortex', slug: 'getting-started/first-cortex' },
            { label: 'Connect Your AI', slug: 'getting-started/connect-ai' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Adding Content', slug: 'guides/adding-content' },
            { label: 'Correcting Memories', slug: 'guides/correcting-memories' },
            { label: 'Graphs & Sensitivity Tiers', slug: 'guides/graphs-and-tiers' },
            { label: 'Memory Across AI Clients', slug: 'guides/memory-across-ai-clients' },
            { label: 'Keeping Your Cortex Safe', slug: 'guides/keeping-your-cortex-safe' },
            { label: 'Recovery', slug: 'guides/recovery' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'MCP Tools', slug: 'reference/mcp-tools' },
            { label: 'File Formats', slug: 'reference/file-formats' },
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
