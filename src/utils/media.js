// Media handling: every capture is (1) copied into the app's private
// document directory (survives sweep), and (2) saved into a per-project
// album in the user's photo library so Google Photos / iCloud backup
// keeps working exactly as it does today.

import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';

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

// Non-prompting status check — lets a screen show a persistent "photos
// aren't backing up to your camera roll" banner without interrupting
// capture flow with a permission prompt on every single shot.
export async function getMediaLibraryPermissionStatus() {
  try {
    const { status, canAskAgain } = await MediaLibrary.getPermissionsAsync();
    return { granted: status === 'granted', canAskAgain };
  } catch (e) {
    return { granted: false, canAskAgain: true };
  }
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
    // Never lose a capture because the album save failed — the app copy from
    // persistToApp() already has it. But log it: a silently-swallowed
    // failure here means "photos aren't backing up" goes unnoticed for an
    // entire survey.
    console.warn('[media] saveToProjectAlbum failed:', e);
    return null;
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

// Opens the OS share sheet for one file so the user can pick Google Photos.
// expo-sharing only supports a single file per call (Android has no public
// Expo API for a true multi-select ACTION_SEND_MULTIPLE without adding a
// native module + full eas build), so batches are driven as a sequential
// loop by the caller, one share-sheet prompt per item.
export async function shareToGooglePhotos(uri) {
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('Sharing is not available on this device.');
  const mimeType = uri.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg';
  await Sharing.shareAsync(uri, { mimeType, dialogTitle: 'Save to Google Photos' });
}

// Hand a video to the device's own player via the share sheet. The app has
// no in-app video player (adding one is a native dep + full build), so this
// is the JS-only pathway for reviewing walkthrough clips.
export async function openVideoExternally(uri) {
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(uri, { mimeType: 'video/mp4', dialogTitle: 'Open video with…' });
}
