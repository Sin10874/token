import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: {
          DEFAULT: '#060709',
          surface: '#0d1018',
          elevated: '#141720',
          hover: '#191d2a',
        },
        border: {
          subtle: '#181c27',
          DEFAULT: '#1f2435',
          bright: '#2a3048',
        },
        text: {
          primary: '#e8ebf0',
          secondary: '#7a8399',
          muted: '#3d4459',
        },
        amber: {
          DEFAULT: '#f5a623',
          bright: '#ffc042',
          dim: '#8a5c12',
          bg: '#160e04',
        },
        teal: {
          DEFAULT: '#38bdf8',
          bright: '#7dd3fc',
          dim: '#164e63',
          bg: '#040d14',
        },
        emerald: {
          DEFAULT: '#4ade80',
          dim: '#14532d',
        },
        rose: {
          DEFAULT: '#f87171',
          dim: '#7f1d1d',
        },
      },
      fontFamily: {
        mono: ['"DM Mono"', '"Cascadia Code"', '"Fira Code"', 'monospace'],
        sans: ['"Barlow"', '"DM Sans"', 'system-ui', 'sans-serif'],
        display: ['"Barlow Condensed"', '"Barlow"', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.65rem', { lineHeight: '1rem' }],
      },
    },
  },
  plugins: [],
} satisfies Config
