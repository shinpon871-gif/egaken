'use client';

import ClothSimulator from '../../components/ClothSimulator';

export default function ClothSimPage() {
  return (
    <main className="w-full h-screen bg-slate-950 text-slate-100">
      <div className="relative w-full h-full">
        <ClothSimulator />
      </div>
    </main>
  );
}
