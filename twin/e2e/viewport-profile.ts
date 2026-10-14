/** Physical 1600×830 at 125% scaling: CSS 1280×664, not CSS 1600×830. */
export const DESKTOP_125 = { width: 1280, height: 664, dpr: 1.25 } as const;
export const DESKTOP_125_USE = {
  viewport: { width: DESKTOP_125.width, height: DESKTOP_125.height },
  deviceScaleFactor: DESKTOP_125.dpr,
} as const;

/** Set deviceScaleFactor with test.use before creating the context.
 * setViewportSize alone does not change DPR. Keep true CSS1600 coverage separate.
 */

/** Keep the formal rendering flags; constrain renderer count for low-memory targeted runs. */
export const RESOURCE_LIMITED_LAUNCH = {
  args: ["--disable-frame-rate-limit", "--disable-gpu-vsync", "--renderer-process-limit=1"],
};
