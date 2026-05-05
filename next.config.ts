import type {NextConfig} from 'next';

const normalizeAuthDomain = (value: string | undefined) =>
  value?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

const firebaseProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim();
const firebaseAuthDomain = normalizeAuthDomain(process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN);
const firebaseAuthHelperDomain =
  normalizeAuthDomain(process.env.NEXT_PUBLIC_FIREBASE_AUTH_HELPER_DOMAIN)
  || (firebaseProjectId ? `${firebaseProjectId}.firebaseapp.com` : undefined);

const shouldProxyFirebaseAuth =
  Boolean(firebaseAuthDomain && firebaseAuthHelperDomain)
  && firebaseAuthDomain !== firebaseAuthHelperDomain;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  // Allow access to remote image placeholder.
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**', // This allows any path under the hostname
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        port: '',
        pathname: '/**',
      },
    ],
  },
  output: 'standalone',
  transpilePackages: ['motion'],
  async headers() {
    return [
      {
        source: '/login',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin-allow-popups',
          },
        ],
      },
    ];
  },
  async rewrites() {
    if (!shouldProxyFirebaseAuth || !firebaseAuthHelperDomain) return [];

    return [
      {
        source: '/__/auth/:path*',
        destination: `https://${firebaseAuthHelperDomain}/__/auth/:path*`,
      },
      {
        source: '/__/firebase/:path*',
        destination: `https://${firebaseAuthHelperDomain}/__/firebase/:path*`,
      },
    ];
  },
};

export default nextConfig;
