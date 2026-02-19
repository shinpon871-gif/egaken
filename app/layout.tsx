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
  title: "えがけん",
  description: "お絵描きの記録を毎日続けるWebアプリ",
  openGraph: {
    title: "えがけん",
    description: "お絵描きの記録アプリ",
    type: "website",
    images: ["/ogp.png"],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/ogp.png"],
  },
  icons: {
    icon: "/egaken.png",
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
