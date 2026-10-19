import type { Recipe } from '@stills/recipe';

/**
 * DynamoDB single table. Keys:
 *
 *   ALBUM#<id>      META               album
 *   ALBUM#<id>      STILL#<stillId>    membership (an album can draw stills from others)
 *   STILL#<id>      META               still
 *   STILL#<id>      VER#<0000001>      a version: the recipe, who and when
 *   HASH#<sha256>   META               exact-duplicate lookup
 *   GALLERY#<token> META               gallery
 *   GALLERY#<token> EVT#<iso>#<rand>   view / download / zip log
 *   ZIP#<id>        META               zip job
 *   APPKEY#<hash>   META               an app's key (the key itself is never stored)
 *   USER#<sub>      SEARCH#<id>        saved search
 *
 * GSIs:
 *   gsi1 (gsi1pk, gsi1sk): type listings, newest first: ALBUM | STILL | GALLERY | APP
 *   gsi2 (gsi2pk, gsi2sk): JOB#<jobId>  (albums, stills, galleries for an engine job)
 *   gsi3 (gsi3pk, gsi3sk): CLIENT#<client>
 */

export type Company = 'bigsmall' | 'atspeed' | 'serpentine' | 'happened';
export const COMPANIES: Company[] = ['bigsmall', 'atspeed', 'serpentine', 'happened'];

export type People = 'none' | 'crowd' | 'identifiable';

export interface Album {
  id: string;
  name: string;
  company: Company;
  client?: string;
  /** The Production Engine's job id. One job can have several albums; the engine uses the first. */
  jobId?: string;
  /** Recipe new stills start from. */
  look?: Recipe;
  /** Days from creation. Stills only in expired albums are deleted. */
  retentionDays?: number;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
}

export interface Exif {
  camera?: string;
  lens?: string;
  takenAt?: string;
  iso?: number;
  shutter?: string;
  aperture?: number;
  focalLength?: number;
  /** Kept, but hidden unless asked for (?gps=1, staff only). */
  gps?: { lat: number; lon: number };
}

export interface Rights {
  /** Who may use it, e.g. "Client and Big Small TV". */
  who?: string;
  /** Where, e.g. "Social and web, UK". */
  where?: string;
  /** ISO date; after this the still is flagged. */
  until?: string;
  notes?: string;
}

export interface Release {
  status: 'none' | 'pending' | 'signed' | 'not-needed';
  /** Link to the engine's release form. */
  url?: string;
}

export type StillStatus = 'pending' | 'ready' | 'failed' | 'duplicate';

export interface Still {
  id: string;
  status: StillStatus;
  filename: string;
  contentType: string;
  bytes?: number;
  originalKey: string;
  /** Full-size JPEG made from formats sharp cannot read directly (HEIC). */
  masterKey?: string;
  sha256?: string;
  /** 64-bit difference hash (hex), for near-duplicates. */
  phash?: string;
  duplicateOf?: string;
  error?: string;

  /** Oriented size in pixels. */
  w?: number;
  h?: number;
  orientation?: 'landscape' | 'portrait' | 'square';
  /** Mean colour (#rrggbb) and its nearest name, for colour search. */
  colour?: string;
  colourName?: string;

  exif?: Exif;
  title?: string;
  description?: string;
  tags?: string[];
  companies: Company[];
  client?: string;
  jobId?: string;
  albumIds: string[];
  credit?: string;
  rights?: Rights;
  release?: Release;
  people?: People;
  /** AI-made. Always labelled, never chosen automatically. */
  ai?: boolean;

  recipe: Recipe;
  version: number;
  versionAt?: string;
  versionBy?: string;

  uploadedBy: string;
  uploadedAt: string;
  updatedAt?: string;
}

export interface Version {
  stillId: string;
  version: number;
  recipe: Recipe;
  by: string;
  at: string;
  basedOn: number;
  note?: string;
}

export type DownloadSizes = 'none' | 'web' | 'full' | 'both';

export interface Gallery {
  token: string;
  title: string;
  company: Company;
  albumId?: string;
  stillIds?: string[];
  jobId?: string;
  client?: string;
  passwordHash?: string;
  expiresAt: string;
  withdrawnAt?: string;
  downloads: DownloadSizes;
  watermark?: boolean;
  createdBy: string;
  createdAt: string;
}

export interface GalleryEvent {
  at: string;
  kind: 'view' | 'download' | 'zip';
  device: 'phone' | 'tablet' | 'computer';
  stillId?: string;
  size?: string;
}

export interface ZipJob {
  id: string;
  status: 'queued' | 'working' | 'ready' | 'failed';
  size: 'web' | 'full';
  galleryToken?: string;
  stillIds: string[];
  email?: string;
  key?: string;
  error?: string;
  requestedBy: string;
  createdAt: string;
  readyAt?: string;
}

export interface App {
  app: string;
  /** Companies the app may see. Missing means all. */
  companies?: Company[];
  webhookUrl?: string;
  /** Secrets Manager name holding the webhook signing secret. */
  webhookSecret?: string;
  events?: WebhookEvent[];
}

export type WebhookEvent = 'still.ready' | 'still.version' | 'gallery.viewed' | 'gallery.selects' | 'zip.ready';

/** Who is calling. */
export type Principal =
  | { kind: 'user'; id: string; email?: string; name?: string }
  | { kind: 'app'; id: string; companies?: Company[] };
