import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Operator",
    short_name: "Operator",
    description: "Control your computers with an AI agent",
    start_url: "/",
    display: "standalone",
    background_color: "#0f1216",
    theme_color: "#0f1216",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
