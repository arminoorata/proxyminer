import type { Metadata } from "next";
import { JetBrains_Mono, Outfit } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

import PeerSetTray from "@/components/peer-set/PeerSetTray";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

const jbMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jbm",
  display: "swap",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://proxyminer.arminoorata.com"),
  title: {
    default: "ProxyMiner",
    template: "%s — ProxyMiner",
  },
  description:
    "Source-grounded executive compensation research, built on public SEC proxy filings. By Armi Noorata.",
  applicationName: "ProxyMiner",
  authors: [{ name: "Armi Noorata", url: "https://arminoorata.com" }],
  creator: "Armi Noorata",
  keywords: [
    "executive compensation",
    "SEC proxy",
    "CD&A",
    "Total Rewards",
    "compensation benchmarking",
    "Armi Noorata",
  ],
  openGraph: {
    type: "website",
    url: "https://proxyminer.arminoorata.com",
    siteName: "ProxyMiner",
    title: "ProxyMiner",
    description:
      "Source-grounded executive compensation research, built on public SEC proxy filings.",
  },
  twitter: {
    card: "summary",
    title: "ProxyMiner",
    description:
      "Source-grounded executive compensation research, built on public SEC proxy filings.",
    creator: "@arminoorata",
  },
};

// Dark default; returning visitors keep their localStorage choice. Same
// bootstrap script as every sibling tool — runs in <head> before paint
// to avoid the dark→light flash.
const bootstrap = `(function(){try{var s=localStorage.getItem('theme');var t=s||'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${outfit.variable} ${jbMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootstrap }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        <SiteHeader />
        <div className="flex-1">{children}</div>
        <SiteFooter />
        <PeerSetTray />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
