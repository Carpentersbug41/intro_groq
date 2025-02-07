const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
});

module.exports = withBundleAnalyzer({
  typescript: {
    ignoreBuildErrors: true, // ✅ This will ignore TypeScript errors during build
  },
});
