/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#eff6ff', 100: '#dbeafe', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' },
        ink: '#0f172a',
      },
      boxShadow: {
        panel: '0 12px 32px rgba(15, 23, 42, 0.06)',
      },
    },
  },
  plugins: [],
}
