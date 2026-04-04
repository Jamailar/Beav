/** @type {import('tailwindcss').Config} */
const semanticColor = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../desktop/src/**/*.{js,ts,jsx,tsx}'
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: semanticColor('--color-background'),
        surface: {
          primary: semanticColor('--color-surface-primary'),
          secondary: semanticColor('--color-surface-secondary'),
          elevated: semanticColor('--color-surface-elevated')
        },
        border: semanticColor('--color-border'),
        divider: semanticColor('--color-divider'),
        text: {
          primary: semanticColor('--color-text-primary'),
          secondary: semanticColor('--color-text-secondary'),
          tertiary: semanticColor('--color-text-tertiary')
        },
        accent: {
          primary: semanticColor('--color-accent-primary'),
          hover: semanticColor('--color-accent-hover'),
          muted: semanticColor('--color-accent-muted')
        },
        status: {
          success: semanticColor('--color-status-success'),
          warning: semanticColor('--color-status-warning'),
          error: semanticColor('--color-status-error')
        },
        brand: {
          red: semanticColor('--color-brand-red'),
          'red-text': semanticColor('--color-brand-red-text')
        }
      }
    }
  },
  plugins: []
};
