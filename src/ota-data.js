import { Capacitor, registerPlugin } from '@capacitor/core';

export const OTA_MANIFEST_URL = 'https://tbilisi-trans.samshabrg.org/ota/manifest.json';

const OtaData = registerPlugin('OtaData');

function isNativeOtaAvailable() {
    if (typeof Capacitor === 'undefined') return false;
    if (typeof Capacitor.isNativePlatform === 'function' && !Capacitor.isNativePlatform()) return false;
    if (typeof Capacitor.getPlatform === 'function' && Capacitor.getPlatform() !== 'ios') return false;
    return true;
}

export async function checkRouteDataUpdates() {
    if (!isNativeOtaAvailable()) {
        return { status: 'unsupported' };
    }

    return OtaData.checkForUpdates({ manifestUrl: OTA_MANIFEST_URL });
}

export async function getActiveRouteDataManifest() {
    if (!isNativeOtaAvailable()) return null;

    try {
        const result = await OtaData.getActiveManifest();
        return result?.manifest || null;
    } catch (err) {
        return null;
    }
}

export async function getOtaDataFileText(filename) {
    if (!isNativeOtaAvailable()) return null;

    try {
        const result = await OtaData.getFile({ filename });
        return typeof result?.content === 'string' ? result.content : null;
    } catch (err) {
        return null;
    }
}

export async function getOtaDataFileJson(filename) {
    const text = await getOtaDataFileText(filename);
    if (!text) return null;
    return JSON.parse(text);
}
