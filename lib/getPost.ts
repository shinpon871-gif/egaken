import { adminDb } from './firebaseAdmin';

export async function getPostById(recordId: string) {
  const doc = await adminDb.collection('posts').doc(recordId).get();

  if (!doc.exists) return null;

  return doc.data() as {
    imageUrl?: string;
    title?: string;
    comment?: string;
  };
}
