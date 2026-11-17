import type { NextConfig } from 'next'

/**
 * Next.js config tuned for Cloudflare Workers via @opennextjs/cloudflare.
 *
 * `output: 'standalone'` is the default that opennextjs-cloudflare expects.
 * (In Next 16 the `images.sharp` flag was removed — Cloudflare's adapter
 * handles image optimization internally; for this starter we just disable
 * the Next.js image optimizer entirely since we don't use <Image>.)
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  images: {
    unoptimized: true,
  },
}

export default nextConfig
