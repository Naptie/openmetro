declare module 'cardinal-spline-js' {
  /**
   * Interpolating cardinal spline over a flat [x0, y0, x1, y1, ...] array.
   * Returns a flat array of points along the curve; the output passes
   * exactly through every input point.
   *
   * @param points    flat coordinate array
   * @param tension   0.5 = standard Catmull-Rom
   * @param numOfSegments  sampled points per input segment
   * @param closed    whether the spline loops back to the first point
   */
  export function getCurvePoints(
    points: number[],
    tension?: number,
    numOfSegments?: number,
    closed?: boolean
  ): number[];
}
