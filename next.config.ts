import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Signed document URLs come from Supabase Storage.
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co", pathname: "/storage/v1/**" },
      { protocol: "http", hostname: "localhost", pathname: "/**" },
    ],
  },
};

export default nextConfig;
