/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        sz: {
          bg: {
            deep: '#040810',
            base: '#070D17',
            surface: '#101B2B',
            elevated: '#162437',
            border: 'rgba(148, 163, 184, 0.18)',
            highlight: '#1E2F46',
          },
          text: {
            primary: '#F1F5F9',
            secondary: '#9AAAC0',
            muted: '#64748B',
          },
          cyan: {
            DEFAULT: '#22D3EE',
            glow: 'rgba(34, 211, 238, 0.35)',
            dark: '#0891B2',
          },
          nvidia: {
            DEFAULT: '#76B900',
            glow: 'rgba(118, 185, 0, 0.35)',
            dark: '#4D7800',
          },
          amber: {
            DEFAULT: '#FBBF24',
            glow: 'rgba(251, 191, 36, 0.35)',
            dark: '#D97706',
          },
          red: {
            DEFAULT: '#F87171',
            glow: 'rgba(248, 113, 113, 0.35)',
            dark: '#DC2626',
          },
          violet: {
            DEFAULT: '#A78BFA',
            dark: '#7C3AED',
          },
          status: {
            confirmed: '#F87171',
            suspected: '#FBBF24',
            unknown: '#64748B',
            recovered: '#10B981',
            ruledout: '#38BDF8',
          },
        }
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
      },
      keyframes: {
        pulseGlow: {
          '0%, 100%': { opacity: '1', filter: 'drop-shadow(0 0 8px rgba(34, 211, 238, 0.5))' },
          '50%': { opacity: '0.6', filter: 'drop-shadow(0 0 2px rgba(34, 211, 238, 0.2))' },
        },
      },
      animation: {
        'pulse-glow': 'pulseGlow 2.5s ease-in-out infinite',
      }
    },
  },
  plugins: [],
};
