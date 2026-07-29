const chromiumExtensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
const firefoxExtensionOrigin = /^moz-extension:\/\/[a-z0-9-]{20,64}$/i;
const safariExtensionOrigin = /^safari-web-extension:\/\/[a-z0-9.-]{3,255}$/i;
function isLocalDevelopmentOrigin(origin) {
    try {
        const url = new URL(origin);
        const port = Number(url.port);
        return (url.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
            Number.isInteger(port) &&
            port >= 1 &&
            port <= 65535);
    }
    catch {
        return false;
    }
}
export function isBrowserExtensionOrigin(origin) {
    return (chromiumExtensionOrigin.test(origin) ||
        firefoxExtensionOrigin.test(origin) ||
        safariExtensionOrigin.test(origin));
}
export function isAllowedClientOrigin(origin, allowedOrigins, allowExtensionOrigins) {
    if (!origin)
        return true;
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin))
        return true;
    if (isLocalDevelopmentOrigin(origin))
        return true;
    return allowExtensionOrigins && isBrowserExtensionOrigin(origin);
}
