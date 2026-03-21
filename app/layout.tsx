// app/layout.tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://egaken.vercel.app"),
  title: {
    default: "えがけん",
    template: "%s | えがけん",
  },
  description: "お絵描きの記録を毎日続けるWebアプリ",
  icons: {
    icon: "/egaken.png",
  },
  openGraph: {
    title: {
      default: "えがけん",
      template: "%s | えがけん",
    },
    description: "お絵描きの記録を毎日続けるWebアプリ",
    type: "website",
    locale: "ja_JP",
  },
  twitter: {
    card: "summary_large_image",
    title: "えがけん",
    description: "お絵描きの記録を毎日続けるWebアプリ",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}