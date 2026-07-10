/** @type {import('next').NextConfig} */
const nextConfig = {
  // route.js reads axe-core's browser bundle via a runtime-constructed file
  // path (not a static import), specifically to work around a Next.js
  // dev-bundler bug affecting the alternative (require.resolve()). Vercel's
  // serverless build only ships files its static tracing can detect a route
  // depending on, and a dynamically-built path is invisible to that
  // analysis — without this, the file is silently missing in production
  // (ENOENT at runtime) even though it's always present in local dev.
  outputFileTracingIncludes: {
    "/api/react": ["./node_modules/axe-core/axe.min.js"],
  },
};

module.exports = nextConfig;
