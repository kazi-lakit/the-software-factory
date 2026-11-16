import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0c1114",
        surface: "#eef2f3"
      }
    }
  },
  plugins: []
} satisfies Config;
