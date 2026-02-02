import { defineConfig } from 'vitepress'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  ignoreDeadLinks: true,
  themeConfig: {
    // Shown in the default VitePress navbar on documentation pages
    logo: '/coleo-logo.png',
    sidebar: {
      '/': [
        { text: 'Getting Started', link: '/guides/getting-started' },
        {
          text: 'Guides',
          items: [
            { text: 'CLI', link: '/guides/cli' },
            { text: 'Docker', link: '/guides/docker' }
          ]
        },
        { text: 'Philosophy', link: '/philosophy' },
        {
          text: 'Architecture',
          items: [
            { text: 'Overview', link: '/architecture/overview' },
            { text: 'Components', link: '/architecture/components' },
            { text: 'Security', link: '/architecture/security' }
          ]
        }
      ]
    }
  },
  head: [
    // Fonts to match marketing2.html
    [
      'link',
      {
        rel: 'preconnect',
        href: 'https://fonts.googleapis.com'
      }
    ],
    [
      'link',
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossorigin: ''
      }
    ],
    [
      'link',
      {
        rel: 'stylesheet',
        href:
          'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600&display=swap'
      }
    ]
  ],
  vite: {
    plugins: [tailwindcss()]
  }
})
