const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { app, shell } = require('electron');
const logger = require('../utils/logger');
const { getConfig, store } = require('../utils/config');
const { binaryName, getFfmpegPath, getFfprobePath } = require('../audio/ffmpeg-path');

const MAX_CONSECUTIVE_FAILURES = 3; // background checks pause after this many failures in a row
const BACKGROUND_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// macOS builds are ad-hoc signed, and Squirrel.Mac refuses to install an update into an app
// without a stable signature. Until there is a Developer ID, the Mac app only checks
// latest-mac.yml and sends the user to the release page to download the new DMG. Flip this to
// true once mac builds are Developer ID signed and notarized.
const CAN_SELF_UPDATE = process.platform !== 'darwin';

let currentStatus = 'idle'; // 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
let updateInfo = null;
let downloadProgress = { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 };
let lastCheckTime = null;
let errorMessage = null;
let consecutiveFailures = 0;
let backgroundChecksSuspended = false;
let postUpdateCheck = null; // null | { version, ok, missing: string[], checkedAt }
let sendToRendererCallback = null;
let onUpdateDownloadedCallback = null;
let checkInterval = null;

function broadcastState() {
  if (typeof sendToRendererCallback === 'function') {
    sendToRendererCallback('updater:status', getUpdaterState());
  }
}

function getUpdaterState() {
  return {
    status: currentStatus,
    currentVersion: app.getVersion(),
    updateInfo,
    downloadProgress,
    lastCheckTime,
    errorMessage,
    consecutiveFailures,
    backgroundChecksSuspended,
    postUpdateCheck,
    isPackaged: app.isPackaged,
    canSelfUpdate: CAN_SELF_UPDATE,
  };
}

// Minimal numeric semver compare (good enough for the plain X.Y.Z tags this project publishes).
// Returns 1 if a>b, -1 if a<b, 0 if equal/unparseable.
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Verifies that resources critical to app functionality (bundled FFmpeg/FFprobe) actually
 * exist on disk. Run after a version change is detected so a broken release (e.g. a CI build
 * that shipped without extraResources) is caught instead of failing silently mid-recording.
 */
function verifyBundledResources() {
  const checks = [
    { name: binaryName('ffmpeg', process.platform), path: getFfmpegPath() },
    { name: binaryName('ffprobe', process.platform), path: getFfprobePath() },
  ];
  const missing = checks.filter((c) => !fs.existsSync(c.path)).map((c) => c.name);
  return { ok: missing.length === 0, missing };
}

/**
 * Detects whether the app was just updated (installed version differs from the last one we
 * recorded) and, if so, runs the bundled-resource integrity check so a broken release surfaces
 * as a clear "update incomplete" state instead of a confusing runtime error later.
 */
function runPostUpdateCheck() {
  if (!app.isPackaged) return;

  const currentVersion = app.getVersion();
  const lastSeenVersion = store.get('lastSeenVersion');

  if (lastSeenVersion && lastSeenVersion !== currentVersion) {
    const result = verifyBundledResources();
    postUpdateCheck = { version: currentVersion, ok: result.ok, missing: result.missing, checkedAt: new Date().toISOString() };
    if (!result.ok) {
      logger.warn('Post-update integrity check failed — bundled resources missing', { version: currentVersion, missing: result.missing });
    } else {
      logger.info('Post-update integrity check passed', { version: currentVersion });
    }
    broadcastState();
  }

  store.set('lastSeenVersion', currentVersion);
}

function setupAutoUpdaterEvents() {
  // Never auto-download or auto-install: every step needs an explicit user action so a bad
  // release can't silently apply itself in the background.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    currentStatus = 'checking';
    errorMessage = null;
    logger.info('AutoUpdater: checking for updates...');
    broadcastState();
  });

  autoUpdater.on('update-available', (info) => {
    consecutiveFailures = 0;
    backgroundChecksSuspended = false;
    currentStatus = 'available';
    updateInfo = {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate,
    };
    logger.info('AutoUpdater: update available', { version: info.version });
    broadcastState();
  });

  autoUpdater.on('update-not-available', (info) => {
    consecutiveFailures = 0;
    backgroundChecksSuspended = false;
    currentStatus = 'not-available';
    updateInfo = {
      version: info.version,
    };
    logger.info('AutoUpdater: app is up to date', { version: info.version });
    broadcastState();
  });

  autoUpdater.on('download-progress', (progressObj) => {
    currentStatus = 'downloading';
    downloadProgress = {
      percent: Math.round(progressObj.percent || 0),
      bytesPerSecond: Math.round(progressObj.bytesPerSecond || 0),
      transferred: Math.round(progressObj.transferred || 0),
      total: Math.round(progressObj.total || 0),
    };
    broadcastState();
  });

  autoUpdater.on('update-downloaded', (info) => {
    currentStatus = 'downloaded';
    updateInfo = {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate,
    };
    logger.info('AutoUpdater: update downloaded and ready to install', { version: info.version });
    broadcastState();
    if (typeof onUpdateDownloadedCallback === 'function') {
      try {
        onUpdateDownloadedCallback(updateInfo);
      } catch (err) {
        logger.warn('Error in onUpdateDownloaded callback', { error: err.message });
      }
    }
  });

  autoUpdater.on('error', (err) => {
    currentStatus = 'error';
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      backgroundChecksSuspended = true;
      logger.warn(`AutoUpdater: ${consecutiveFailures} consecutive failures — pausing background checks until a manual retry`);
    }

    const raw = err?.message || 'Error checking for updates';
    // Provide a friendly error message — strip raw download URLs to avoid noise
    let friendlyMessage = raw;
    if (/sha512|checksum|integrity/i.test(raw)) {
      friendlyMessage = 'Downloaded update failed integrity verification and was discarded. Please try again later.';
    } else if (/cannot download/i.test(raw) || /net::/i.test(raw) || /ENOTFOUND/i.test(raw) || /ETIMEDOUT/i.test(raw)) {
      friendlyMessage = 'Unable to download update. The release may not be ready yet — please try again later.';
    } else if (/404/i.test(raw) || /not found/i.test(raw)) {
      friendlyMessage = 'Update release not found on GitHub. It may still be publishing.';
    } else if (/403/i.test(raw) || /forbidden/i.test(raw)) {
      friendlyMessage = 'Access denied when checking for updates.';
    } else if (raw.length > 120) {
      // Truncate overly long messages that usually contain URLs
      friendlyMessage = raw.substring(0, 120).replace(/https?:\/\/\S+/g, '').trim() + '…';
    }
    errorMessage = friendlyMessage;
    logger.warn('AutoUpdater error', { error: raw, consecutiveFailures });
    broadcastState();
  });
}

function initializeAutoUpdater({ sendToRenderer, onUpdateDownloaded }) {
  sendToRendererCallback = sendToRenderer;
  onUpdateDownloadedCallback = onUpdateDownloaded;

  runPostUpdateCheck();
  logger.info('AutoUpdater: update checks disabled for MeetScribe build');
}

async function checkForUpdates(manual = false) {
  lastCheckTime = new Date().toISOString();
  currentStatus = 'not-available';
  errorMessage = null;
  broadcastState();
  return {
    success: true,
    status: 'not-available',
    disabled: true,
    currentVersion: app.getVersion(),
  };
}

/**
 * Downloads updates (disabled for this standalone/hackathon build).
 */
async function downloadUpdate() {
  return { success: false, error: 'Automatic updates are disabled for this build.' };
}

function quitAndInstall() {
  if (currentStatus === 'downloaded') {
    logger.info('AutoUpdater: restarting and installing update...');
    // set isQuitting flag if necessary
    app.isQuitting = true;
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
  }
  return { success: false, error: 'No update downloaded yet' };
}

module.exports = {
  initializeAutoUpdater,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  getUpdaterState,
};
