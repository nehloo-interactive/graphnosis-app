/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#13131a',
        surface: '#1c1c27',
        border: '#2a2a3d',
        accent: '#67e8f9',
        glow: '#a78bfa',
        'text-primary': '#f0f0f5',
        'text-muted': '#71717a',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
