const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
});

module.exports = withBundleAnalyzer({
  experimental: {
    appDir: true, // Enable the new app directory feature
  },
  typescript: {
    ignoreBuildErrors: true, // This will ignore TypeScript errors during build
  },
});
