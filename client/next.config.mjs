import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001",
  },
  // Resolve `./foo.js` imports to `./foo.ts` (TS ESM convention). Needed because
  // vendor/shared/contracts/*.ts use the `.js` suffix on relative imports so the
  // server's Node ESM (via tsx) stays correct. Webpack does not do this by default
  // even with moduleResolution: "Bundler" in tsconfig.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default withNextIntl(nextConfig);
