// Backend selection follows Blur my Shell's GNOME Rounded Blur integration.
// https://github.com/aunetx/blur-my-shell/blob/master/src/effects/native_dynamic_gaussian_blur.js

/**
 * Prefer a usable GNOME Rounded Blur namespace, keeping its effect and enum
 * together. An absent or incompatible optional library must not break the dock.
 *
 * @param compatibility
 * @param native
 * @param typeName
 */
export function selectBlurBackend(compatibility, native, typeName) {
    try {
        const effectType = compatibility?.BlurEffect;
        if (typeof effectType === 'function' && effectType.$gtype &&
            typeName(effectType.$gtype) && compatibility.BlurMode?.BACKGROUND !== undefined)
            return compatibility;
    } catch {
        // A typelib can exist while its matching shared library is unavailable.
    }
    return native;
}

/**
 * @param native
 * @param gobject
 */
export async function loadBlurBackend(native, gobject) {
    let compatibility;
    try {
        compatibility = (await import('gi://Blur')).default;
    } catch {
        // The compatibility library is optional, as in Blur my Shell.
    }
    return selectBlurBackend(compatibility, native, type => gobject.type_name(type));
}

// Shared appearance contract: radius is in logical pixels; opacity and
// brightness are percentages. Keep this module identical in both extensions.
export function opacityFraction(value, maximum = 100) {
    return Math.max(0, Math.min(1, value / maximum));
}

export function applyBlurParameters(effect, radiusProperty, radius, scale, brightness = 85) {
    const physicalRadius = radius * scale;
    effect[radiusProperty] = radiusProperty === 'radius' ? physicalRadius : physicalRadius / 2;
    effect.brightness = opacityFraction(brightness);
}
