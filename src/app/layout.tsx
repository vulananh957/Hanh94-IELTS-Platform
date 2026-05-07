import type {Metadata} from 'next';
import { Inter, Playfair_Display } from 'next/font/google';
import './globals.css'; // Global styles
import { RuntimeRecoveryGuard } from '@/components/runtime-recovery-guard';

export const dynamic = 'force-dynamic';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-serif',
});

export const metadata: Metadata = {
  title: 'hanh94esl - Premium IELTS Platform',
  description: 'Experience the future of IELTS preparation with our premium platform.',
  applicationName: 'hanh94esl',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      {url: '/icons/favicon.ico'},
      {url: '/icons/favicon-16x16.png', type: 'image/png', sizes: '16x16'},
      {url: '/icons/favicon-32x32.png', type: 'image/png', sizes: '32x32'},
      {url: '/icons/favicon.svg', type: 'image/svg+xml'},
    ],
    apple: [{url: '/icons/apple-touch-icon.png', sizes: '180x180'}],
    shortcut: ['/icons/favicon.ico'],
  },
  appleWebApp: {
    capable: true,
    title: 'hanh94esl',
    statusBarStyle: 'default',
  },
  formatDetection: {
    telephone: false,
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable}`}>
      <head>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
      </head>
      <body className="font-sans antialiased" suppressHydrationWarning>
        <RuntimeRecoveryGuard />
        {children}
      </body>
    </html>
  );
}
