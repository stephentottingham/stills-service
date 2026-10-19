# RAWs and the office Synology

RAW files are kept on the office Synology, not in AWS. JPEGs (and TIFF, PNG, HEIC) live in Stills Engine as usual.

## How it works

1. A photographer drops a whole card folder (RAWs and JPEGs) on an album.
2. **The uploader tests the connection** (two short uploads to the same London S3 region) and estimates the time:
   - up to 10 minutes: "Go ahead";
   - up to 45 minutes: "Go ahead: time for a coffee";
   - longer: "JPEGs now (about N minutes), RAWs later from a faster connection";
   - when even the JPEGs are slow, it says so.
   The photographer picks **Upload everything** or **JPEGs now, RAWs later**.
3. **RAWs with no JPEG beside them** (RAW-only shooting) can get a JPEG made in the browser from the camera's built-in preview (nearly every camera embeds a full-size or large one). These are marked "JPEG from the RAW preview". They are the camera's processing, not a photographer's edit.
4. JPEGs go into the library first. RAWs go to the **RAW inbox**, an S3 bucket in London, under `raw/<company>/<date>-<album>_<album id>/`.
5. **Cloud Sync on the Synology** pulls `raw/` down into the RAW shared folder, with the same folders.
6. The inbox clears each RAW after **30 days**, by which time the Synology has it.
7. Each RAW is paired with the JPEG of the same name (`IMG_0001.CR3` with `IMG_0001.jpg`). The still shows "RAW" and its path on the server.

**Carrying on later.** Drop the same folder again, from home or the office. Anything already sent is skipped, so only the RAWs (and anything that failed) go.

## Security

- Photographers never connect to the Synology. They sign in to Stills Engine and upload to S3 with short-lived links.
- The Synology only makes **outgoing** connections. No ports are opened; there is no FTP and no QuickConnect for this.
- The Synology has its own AWS user, `stills-engine-synology`. It can list, read and delete inside `raw/` of the RAW inbox, and nothing else: no JPEGs, galleries, database or other buckets.
- The inbox is private and encrypted, and only accepts HTTPS.

## Setting up the Synology (once, after the first deploy)

Menu wording can differ slightly between DSM versions.

1. **AWS console** (Stills Engine account) → IAM → Users → `stills-engine-synology` → Security credentials → **Create access key** ("Application running outside AWS"). Keep the page open. Don't save the key anywhere else.
2. **Synology DSM** → Package Centre → install **Cloud Sync**.
3. Cloud Sync → **+** → **Amazon S3** → region **Europe (London)**, and paste the access key and secret from step 1.
4. **Bucket:** the `RawInboxBucket` stack output.
5. **Local path:** the RAW shared folder, e.g. `/RAW/Stills Engine`. **Remote path:** `raw`.
6. **Sync direction: Download remote changes only.**
7. **Turn on "Don't remove files in the local folder when they are removed in the remote folder".** The inbox clears itself after 30 days; the Synology must keep its copies.
8. Polling interval: 5–10 minutes is plenty.
9. Close the AWS page. The key now lives only in Cloud Sync. If the Synology is replaced, make a new key and delete the old one.

Back up the RAW folder off-site (Hyper Backup). Once the inbox clears, the Synology holds the only copy.

## Deleting

Deleting a still deletes its RAW from the inbox if it is still there. **The Synology's copy has to be deleted on the Synology** (the still shows the path). The same goes for albums cleared by retention, and for requests to delete a person's data.

## Limits

- 500 MB per file. Upload links last 6 hours, so very slow uploads can finish.
- A dropped connection loses only the file in flight. Drop the folder again to carry on.
- Speed is measured before the upload, so it is an estimate. The progress line shows the real rate and time left as it goes.
