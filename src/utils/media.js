// Media handling: every capture is (1) copied into the app's private
// document directory (survives sweep), and (2) saved into a per-project
// album in the user's photo library so Google Photos / iCloud backup
// keeps working exactly as it does today.

import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';

const DIR = FileSystem.documentDirectory + 'surveys/';

export async function ensureDir() {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
}

// Copy a temp capture into permanent app storage.
export async function persistToApp(tempUri, ext = 'jpg') {
  await ensureDir();
  const dest = `${DIR}${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
  await FileSystem.copyAsync({ from: tempUri, to: dest });
  return dest;
}

// Save into the user's photo library under a per-project album.
// Returns the asset id so close-out sweep can surgically delete it later.
export async function saveToProjectAlbum(uri, albumName) {
  const { status } = await MediaLibrary.requestPermissionsAsync();
  if (status !== 'granted') return null;
  try {
    const asset = await MediaLibrary.createAssetAsync(uri);
    let album = await MediaLibrary.getAlbumAsync(albumName);
    if (!album) {
      await MediaLibrary.createAlbumAsync(albumName, asset, false);
    } else {
      await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
    }
    return asset.id;
  } catch (e) {
    return null; // never lose a capture because album save failed
  }
}

// Close-out sweep: remove this project's assets from the user's photo
// library. App copies + exports are untouched. Only deletes assets this
// app created (tracked by id), so personal photos are never at risk.
export async function sweepAssets(assetIds) {
  const ids = assetIds.filter(Boolean);
  if (!ids.length) return 0;
  try {
    await MediaLibrary.deleteAssetsAsync(ids);
    return ids.length;
  } catch (e) {
    return 0;
  }
}

export async function deleteAppFile(uri) {
  try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch (e) {}
}
