// app/nine/[shareId]/layout.tsx
import { ReactNode } from "react";

// 動的メタデータ生成を強制
export const dynamic = 'force-dynamic';
export const revalidate = false;

export default function NineShareLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
