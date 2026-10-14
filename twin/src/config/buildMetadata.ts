// Alternate Vite configs may omit both injected constants. Never access an absent global.
export const buildMetadata = {
  revision:
    (typeof __BUILD_REVISION__ !== "undefined" ? __BUILD_REVISION__ : null) ||
    "源码包",
  time:
    (typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : null) || "源码包",
};
