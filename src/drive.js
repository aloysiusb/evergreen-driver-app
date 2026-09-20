// drive.js — where a driver's photo of a bin actually goes.
//
// Into a folder in EverGreen's own Drive, shared with the service account —
// not into the service account's own storage. That way the photos belong to
// the business: openable, movable, and still there if this app disappears.
// Same arrangement as the route sheet, where we are a guest rather than the
// owner.
//
// The 📷 button used to set a boolean and throw the image away, so the sheet
// said "photo taken" when no photo existed anywhere. This is the part that
// makes that note true.

import { google } from "googleapis";
import { Readable } from "node:stream";

let driveClient = null;

function getCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_KEY.");
  return JSON.parse(raw);
}

async function getDrive() {
  if (driveClient) return driveClient;
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    // drive.file is deliberately narrow: it covers files this app creates,
    // and the folder it was explicitly given. It cannot read the rest of
    // anyone's Drive, which is the right amount of access for a camera button.
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  driveClient = google.drive({ version: "v3", auth: await auth.getClient() });
  return driveClient;
}

export function photosFolderId() {
  return (process.env.PHOTOS_FOLDER_ID || "").trim();
}

/** A name that sorts usefully in Drive and says what it is without opening it. */
function fileNameFor({ tabName, rowNumber, account, mimeType }) {
  const ext = mimeType === "image/webp" ? "webp" : "jpg";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
  const who = String(account || "stop " + rowNumber)
    .replace(/[\\/:*?"<>|]/g, "")   // characters Drive and Windows both dislike
    .slice(0, 48)
    .trim();
  return `${stamp} · ${who} · ${tabName} row ${rowNumber}.${ext}`;
}

/**
 * Upload one JPEG and return a link that works from the spreadsheet.
 * Throws with a readable message — the caller turns it into a 502 rather
 * than telling a driver their photo saved when it did not.
 */
export async function uploadPhoto(buffer, meta) {
  const folderId = photosFolderId();
  if (!folderId) {
    throw new Error("PHOTOS_FOLDER_ID is not set, so there is nowhere to put photos.");
  }

  const drive = await getDrive();

  const file = await drive.files.create({
    requestBody: {
      name: fileNameFor(meta),
      parents: [folderId],
      description:
        `${meta.account || ""} — ${meta.tabName} row ${meta.rowNumber}`.trim(),
    },
    media: {
      mimeType: meta.mimeType || "image/jpeg",
      body: Readable.from(buffer),
    },
    fields: "id, name, webViewLink",
    // Required for a Shared Drive. Without it the call is rejected even when
    // the folder is one — and a Shared Drive is the only arrangement where a
    // service account can create a file at all, because files there are owned
    // by the drive rather than by the account uploading them.
    supportsAllDrives: true,
  });

  return {
    id: file.data.id,
    name: file.data.name,
    // webViewLink opens it in Drive; anyone who can see the folder can see it.
    link: file.data.webViewLink || `https://drive.google.com/file/d/${file.data.id}/view`,
  };
}
