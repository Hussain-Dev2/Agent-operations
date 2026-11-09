import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const hubUrl = process.env.HUB_URL ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The browser talks to one origin; REST is proxied to the hub so the session cookie is first-party.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${hubUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
