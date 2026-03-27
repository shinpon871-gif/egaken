const path = require("path");
const sharp = require("sharp");

const projectRoot = path.resolve(__dirname, "..");
const output = path.join(projectRoot, "public", "top-ogp.png");
const icon = path.join(projectRoot, "public", "egaken.png");

const svg = String.raw`
<svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FFF6DF"/>
      <stop offset="0.55" stop-color="#F7E1B7"/>
      <stop offset="1" stop-color="#EEC18B"/>
    </linearGradient>
    <filter id="shadow" x="0" y="0" width="1200" height="630" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#8A5B35" flood-opacity="0.18"/>
    </filter>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1040" cy="88" r="120" fill="#FFF0C8" fill-opacity="0.55"/>
  <circle cx="182" cy="536" r="144" fill="#FFE4BA" fill-opacity="0.7"/>
  <path d="M790 116C880 92 954 120 1030 160C1098 196 1148 212 1200 206V630H710C704 548 712 470 738 406C762 346 756 274 790 116Z" fill="#F1C78F" fill-opacity="0.4"/>

  <g filter="url(#shadow)">
    <rect x="78" y="88" width="660" height="452" rx="36" fill="#FFF9F0" fill-opacity="0.92" stroke="#8F5F39" stroke-width="3"/>
  </g>

  <text x="128" y="178" fill="#744727" font-family="Arial, sans-serif" font-size="78" font-weight="700">EGAKEN</text>
  <text x="128" y="242" fill="#8F5F39" font-family="Arial, sans-serif" font-size="28" font-weight="600">Keep your daily drawing record in one place.</text>

  <rect x="128" y="292" width="470" height="16" rx="8" fill="#E1B27B" fill-opacity="0.95"/>
  <rect x="128" y="328" width="530" height="16" rx="8" fill="#E9C9A0" fill-opacity="0.95"/>
  <rect x="128" y="364" width="486" height="16" rx="8" fill="#E9C9A0" fill-opacity="0.82"/>

  <text x="128" y="436" fill="#96694C" font-family="Arial, sans-serif" font-size="28">Draw, log time, review progress, and share.</text>

  <rect x="128" y="474" width="238" height="18" rx="9" fill="#D8A369" fill-opacity="0.88"/>
  <rect x="128" y="510" width="194" height="18" rx="9" fill="#E4B985" fill-opacity="0.88"/>
  <rect x="128" y="546" width="280" height="18" rx="9" fill="#EED2AA" fill-opacity="0.92"/>

  <circle cx="846" cy="212" r="96" fill="#FFF4D2" fill-opacity="0.92" stroke="#8F5F39" stroke-width="3"/>
  <circle cx="1010" cy="448" r="56" fill="#FFF1CB" fill-opacity="0.8" stroke="#B07B4E" stroke-width="3"/>
</svg>`;

async function main() {
  const iconBuffer = await sharp(icon)
    .resize({ width: 360, height: 360, fit: "contain" })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: 1200,
      height: 630,
      channels: 4,
      background: "#fff6df",
    },
  })
    .composite([
      { input: Buffer.from(svg), top: 0, left: 0 },
      { input: iconBuffer, top: 150, left: 760 },
    ])
    .png()
    .toFile(output);

  const metadata = await sharp(output).metadata();
  console.log(JSON.stringify({ output, width: metadata.width, height: metadata.height }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});