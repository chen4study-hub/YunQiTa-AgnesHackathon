export const blend = (seconds: number) =>
  1 - Math.exp(-Math.max(0, seconds) * 5);
export function nearestHour(current: number, target: number) {
  return current + ((((target - current + 12) % 24) + 24) % 24) - 12;
}
/** Clamp orbit target to a cylinder around the tower, preserving camera offset. */
export function constrainTarget(
  target: { x: number; y: number; z: number },
  radius = 24,
  height = 100,
) {
  const distance = Math.hypot(target.x, target.z);
  const scale = distance > radius ? radius / distance : 1;
  return {
    x: target.x * scale,
    y: Math.max(0, Math.min(height, target.y)),
    z: target.z * scale,
  };
}
