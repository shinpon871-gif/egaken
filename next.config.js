/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    turbo: false, // Turbopack を無効化して従来の SWC ビルドを使用
  },
};

module.exports = nextConfig;
