/**
 * Static line configuration for cn-fuzhou.
 *
 * All six lines are linear (no branches, no loops). Colors are taken from the
 * official site JSON at runtime; this table only fixes identity, mode and the
 * AMap line name used to join coordinates.
 */

export interface FuzLineConfig {
  /** Mandatory compact display code; 滨海快线 has no numeric code. */
  short: string;
  name: string;
  nameEn: string;
  mode: 'metro' | 'airport_express';
  /** AMap subway `ln` (matches the official name for every Fuzhou line). */
  amapName: string;
}

export const FUZHOU_LINES: FuzLineConfig[] = [
  { short: '1', name: '1号线', nameEn: 'Line 1', mode: 'metro', amapName: '1号线' },
  { short: '2', name: '2号线', nameEn: 'Line 2', mode: 'metro', amapName: '2号线' },
  { short: '4', name: '4号线', nameEn: 'Line 4', mode: 'metro', amapName: '4号线' },
  { short: '5', name: '5号线', nameEn: 'Line 5', mode: 'metro', amapName: '5号线' },
  { short: '6', name: '6号线', nameEn: 'Line 6', mode: 'metro', amapName: '6号线' },
  {
    short: '滨海快线',
    name: '滨海快线',
    nameEn: 'Binhai Express',
    mode: 'airport_express',
    amapName: '滨海快线'
  }
];
