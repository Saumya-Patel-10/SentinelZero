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
            deep: '#06090e',
            base: '#0B0F17',
            surface: '#111827',
            elevated: '#1a2234',
            border: '#24324d',
            highlight: '#334155',
          },
          cyan: {
            DEFAULT: '#06b6d4',
            glow: '#22d3ee',
            dark: '#0e7490',
          },
          status: {
            confirmed: '#ef4444',
            suspected: '#f59e0b',
            unknown: '#64748b',
            recovered: '#10b981',
            ruledout: '#3b82f6',
          },
          accent: {
            primary: '#06b6d4',
            secondary: '#8b5cf6',
          }
        }
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      keyframes: {
        pulseGlow: {
          '0%, 100%': { opacity: '1', filter: 'drop-shadow(0 0 8px rgba(6, 182, 212, 0.6))' },
          '50%': { opacity: '0.6', filter: 'drop-shadow(0 0 2px rgba(6, 182, 212, 0.2))' },
        },
        scanline: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        }
      },
      animation: {
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
        'scanline': 'scanline 8s linear infinite',
      }
    },
  },
  plugins: [],
};

