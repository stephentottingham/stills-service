import { queryAll, batchDelete, clean } from '../lib/aws';
import { Album, Still } from '../lib/model';
import { albumStillIds, getStills, deleteStill, removeFromAlbum, invalidate } from '../lib/stills';

/**
 * Daily. For each album past its retention: stills that are only in expired
 * albums are deleted completely; stills also in a live album just leave this one.
 * Then the album itself goes.
 */
export async function handler(): Promise<{ albums: number; deleted: number; abandoned: number }> {
  const now = Date.now();
  const albums = (
    await queryAll<Record<string, any>>({
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p',
      ExpressionAttributeValues: { ':p': 'ALBUM' },
    })
  ).map((a) => clean<Album>(a));
  const expired = new Set(
    albums.filter((a) => a.retentionDays && Date.parse(a.createdAt) + a.retentionDays * 86400_000 < now).map((a) => a.id),
  );
  let deleted = 0;
  for (const albumId of expired) {
    const stills = await getStills(await albumStillIds(albumId));
    for (const s of stills) {
      if (s.albumIds.every((a) => expired.has(a))) {
        await deleteStill(s.id, { invalidate: false });
        deleted++;
      } else {
        await removeFromAlbum(albumId, s.id);
      }
    }
    const rest = await queryAll<{ pk: string; sk: string }>({
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': `ALBUM#${albumId}` },
      ProjectionExpression: 'pk, sk',
    });
    await batchDelete(rest);
    console.log(`Retention: album ${albumId} removed`);
  }

  // Uploads that were asked for but never arrived.
  const cutoff = new Date(now - 2 * 86400_000).toISOString();
  const pending = (
    await queryAll<Record<string, any>>({
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p AND gsi1sk < :c',
      ExpressionAttributeValues: { ':p': 'STILL', ':c': cutoff },
    })
  )
    .map((s) => clean<Still>(s))
    .filter((s) => s.status === 'pending');
  for (const s of pending) await deleteStill(s.id, { invalidate: false });

  // One invalidation for the whole run (CloudFront limits how many can run at once).
  if (deleted) await invalidate(['/r/*']);

  return { albums: expired.size, deleted, abandoned: pending.length };
}
