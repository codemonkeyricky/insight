/**
 * Moves a camera up so the scene's top edge lands at `reserve` on screen at most. A camera already higher is unchanged.
 * `c.y` is the screen offset of the world origin, so the scene's top sits at `c.y + sceneTop * c.k` on screen.
 */
export function clampTop(c: { x: number; y: number; k: number }, sceneTop: number, reserve: number): { x: number; y: number; k: number } {
  return { ...c, y: Math.min(c.y, reserve - sceneTop * c.k) };
}
