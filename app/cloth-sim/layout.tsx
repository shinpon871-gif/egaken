import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '3D Cloth Simulator | えがけん',
};

export default function ClothSimLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
