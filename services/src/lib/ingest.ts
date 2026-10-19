import { createHash } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import exifr from 'exifr';
import { config } from './config';
import { s3, getObjectBuffer, getItem, putItem } from './aws';
import { Still, Exif, Album } from './model';
import { getStill, setStillFields, addToAlbum, saveRecipe, stillView } from './stills';
import { heicToJpeg, isHeic, orientedSize, dHash, colourOf } from './images';
import { makeRendition } from './renditions';
import { emit } from './events';
import { pairStillWithRaw } from './raw';

/**
 * Processes one uploaded original: hash, duplicate check, EXIF and IPTC,
 * size, colour, perceptual hash, the album's look, and the first renditions.
 */
export async function processUpload(key: string): Promise<void> {
  const m = /^o\/([^/]+)\/original\.[a-z]+$/.exec(key);
  if (!m) return;
  const id = m[1];
  const still = await getStill(id);
  if (!still) {
    // Deleted before it arrived: do not keep the file.
    await s3.send(new DeleteObjectCommand({ Bucket: config.originalsBucket, Key: key }));
    return;
  }
  // Already done (SQS can deliver twice).
  if ((still.status === 'ready' && still.sha256) || still.status === 'duplicate') return;

  try {
    const buf = await getObjectBuffer(config.originalsBucket, key);
    const sha256 = createHash('sha256').update(buf).digest('hex');

    // Exact duplicate: keep the first, put it in this still's albums, drop the copy.
    // Only a first copy that is safely processed counts; otherwise this upload goes ahead.
    const claimed = await claimHash(sha256, id);
    if (claimed !== id) {
      const first = await getStill(claimed);
      if (first?.status === 'ready') {
        for (const albumId of still.albumIds) await addToAlbum(albumId, [first.id]);
        const companies = [...new Set([...first.companies, ...still.companies])];
        if (companies.length !== first.companies.length) await setStillFields(first.id, { companies });
        await setStillFields(id, { status: 'duplicate', duplicateOf: first.id, sha256, bytes: buf.length });
        await s3.send(new DeleteObjectCommand({ Bucket: config.originalsBucket, Key: key }));
        return;
      }
      if (!first || first.status === 'failed') {
        // The first copy was deleted or failed: take the hash over.
        await putItem({ pk: `HASH#${sha256}`, sk: 'META', type: 'hash', stillId: id });
      }
    }

    let source = buf;
    let masterKey: string | undefined;
    if (isHeic(still.contentType, still.filename)) {
      source = await heicToJpeg(buf);
      masterKey = `m/${id}/master.jpg`;
      await s3.send(
        new PutObjectCommand({ Bucket: config.originalsBucket, Key: masterKey, Body: source, ContentType: 'image/jpeg' }),
      );
    }

    const meta = await readMetadata(buf);
    const { w, h } = await orientedSize(source);
    const [phash, colour] = await Promise.all([dHash(source), colourOf(source)]);

    const fields: Partial<Still> = {
      status: 'ready',
      sha256,
      phash,
      bytes: buf.length,
      masterKey,
      w,
      h,
      orientation: w > h * 1.05 ? 'landscape' : h > w * 1.05 ? 'portrait' : 'square',
      ...colour,
      exif: meta.exif,
      // Lightroom's IPTC fills the details, unless someone has set them already.
      title: still.title ?? meta.title,
      description: still.description ?? meta.caption,
      credit: still.credit ?? meta.credit,
      tags: still.tags?.length ? still.tags : meta.keywords,
      rights: still.rights ?? (meta.copyright ? { who: meta.copyright } : undefined),
      updatedAt: new Date().toISOString(),
      error: undefined,
    };
    // Only the fields processing owns, so album or detail changes made meanwhile stay.
    await setStillFields(id, fields);
    let current = (await getStill(id))!;

    // The album's look is the starting point (version 1), unless a retry already applied it.
    const album = await getItem<Album>(`ALBUM#${still.albumIds[0]}`, 'META');
    if (album?.look && current.version === 0) {
      try {
        current = await saveRecipe(current, album.look, 0, 'look', `Album look: ${album.name}`);
      } catch (e: any) {
        if (e.status !== 409) throw e;
        current = (await getStill(id))!;
      }
    }

    // First renditions now, so the library and galleries are quick.
    await makeRendition(current, 't', current.version, source);
    await makeRendition(current, 'm', current.version, source);

    await pairStillWithRaw(id, current.filename, current.albumIds);
    await emit('still.ready', await stillView(current), current.companies);
  } catch (e: any) {
    console.error('Processing failed', id, e);
    await setStillFields(id, { status: 'failed', error: String(e?.message ?? e).slice(0, 500) }, 'attribute_exists(pk) AND #status <> :ready', {
      ':ready': 'ready',
    }).catch(() => {});
    throw e;
  }
}

/** Claims the hash for this still; returns the id of whoever holds it. */
async function claimHash(sha256: string, id: string): Promise<string> {
  try {
    await putItem({ pk: `HASH#${sha256}`, sk: 'META', type: 'hash', stillId: id }, 'attribute_not_exists(pk)');
    return id;
  } catch (e: any) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    const h = await getItem<{ stillId: string }>(`HASH#${sha256}`);
    return h?.stillId ?? id;
  }
}

export interface ReadMeta {
  exif?: Exif;
  title?: string;
  caption?: string;
  credit?: string;
  copyright?: string;
  keywords?: string[];
}

/** EXIF, IPTC and XMP (Lightroom writes captions and keywords to both). */
export async function readMetadata(buf: Buffer): Promise<ReadMeta> {
  let raw: Record<string, any> | undefined;
  try {
    raw = await exifr.parse(buf, { tiff: true, exif: true, gps: true, iptc: true, xmp: true, icc: false, mergeOutput: true });
  } catch {
    raw = undefined;
  }
  if (!raw) return {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = raw![k];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        // XMP language alternatives: { lang: 'x-default', value: '...' }
        if ('value' in v) return String((v as any).value);
        continue;
      }
      return Array.isArray(v) ? v : String(v);
    }
    return undefined;
  };
  const text = (...keys: string[]) => {
    const v = pick(...keys);
    return Array.isArray(v) ? v.map(String).join(', ') : v;
  };
  const camera = [text('Make'), text('Model')].filter(Boolean).join(' ').replace(/^(\w+) \1 /i, '$1 ') || undefined;
  const taken = raw.DateTimeOriginal ?? raw.CreateDate;
  const exif: Exif = {
    camera,
    lens: text('LensModel', 'Lens'),
    takenAt: taken instanceof Date && !isNaN(taken.getTime()) ? taken.toISOString() : undefined,
    iso: typeof raw.ISO === 'number' ? raw.ISO : undefined,
    shutter: typeof raw.ExposureTime === 'number' ? shutterText(raw.ExposureTime) : undefined,
    aperture: typeof raw.FNumber === 'number' ? raw.FNumber : undefined,
    focalLength: typeof raw.FocalLength === 'number' ? raw.FocalLength : undefined,
    gps: typeof raw.latitude === 'number' && typeof raw.longitude === 'number' ? { lat: raw.latitude, lon: raw.longitude } : undefined,
  };
  const kw = pick('Keywords', 'subject');
  const keywords = kw === undefined ? undefined : (Array.isArray(kw) ? kw : String(kw).split(/[,;]/)).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  return {
    exif: Object.values(exif).some((v) => v !== undefined) ? exif : undefined,
    title: text('ObjectName', 'title', 'Headline', 'headline'),
    caption: text('Caption', 'description', 'ImageDescription'),
    credit: text('Byline', 'creator', 'Artist', 'Credit', 'credit'),
    copyright: text('CopyrightNotice', 'rights', 'Copyright'),
    keywords: keywords?.length ? [...new Set(keywords)] : undefined,
  };
}

function shutterText(t: number): string {
  return t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}`;
}
