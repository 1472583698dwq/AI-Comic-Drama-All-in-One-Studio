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
        background: '#0A0A0C',
        surface: {
          DEFAULT: '#121216',
          secondary: '#1A1A22',
          tertiary: '#24242F',
          hover: '#2C2C3A',
        },
        border: {
          DEFAULT: '#262630',
          subtle: '#1C1C24',
          active: '#3F3F50',
        },
        brand: {
          DEFAULT: '#7C3AED',
          light: '#9333EA',
          glow: '#A855F7',
          blue: '#3B82F6',
          cyan: '#06B6D4',
        },
        accent: {
          orange: '#F97316',
          green: '#10B981',
          pink: '#EC4899',
          yellow: '#EAB308',
        }
      },
      fontFamily: {
        sans: ['Inter', 'PingFang SC', 'HarmonyOS Sans', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'pulse-glow': 'pulseGlow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.25s ease-out',
      },
      keyframes: {
        pulseGlow: {
          '0%, 100%': { opacity: 0.8, filter: 'drop-shadow(0 0 12px rgba(124, 58, 237, 0.4))' },
          '50%': { opacity: 1, filter: 'drop-shadow(0 0 24px rgba(124, 58, 237, 0.8))' },
        },
        fadeIn: {
          '0%': { opacity: 0, transform: 'translateY(4px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        }
      }
    },
  },
  plugins: [],
}
