import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Public tunnel hosts that load this dev server (Next.js blocks cross-origin
  // dev resources like HMR unless they are listed here).
  allowedDevOrigins: [
    "plaza-twice-sublease.ngrok-free.dev",
    "bass-candle-transmit-workstation.trycloudflare.com",
  ],
  // Expose the FastAPI/ML backend under /backend/* so a single public tunnel
  // URL serves both the frontend and the backend (e.g. /backend/health).
  rewrites: async () => [
    {
      source: "/backend/:path*",
      destination: "http://localhost:8000/:path*",
    },
  ],
  images: {
    // Signed document URLs come from Supabase Storage.
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co", pathname: "/storage/v1/**" },
      { protocol: "http", hostname: "localhost", pathname: "/**" },
    ],
  },
};

export default nextConfig;
