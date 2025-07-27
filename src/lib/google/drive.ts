// lib/google/drive.ts

import axios from "axios";

export async function fetchDriveFolders(access_token: string) {
  const res = await axios.get("https://www.googleapis.com/drive/v3/files", {
    headers: {
      Authorization: `Bearer ${access_token}`,
    },
    params: {
      q: "'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: "files(id, name)",
    },
  });

  return res.data.files;
}
