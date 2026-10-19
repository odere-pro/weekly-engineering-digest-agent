// Bridge: the capture moved to the capture/ folder (W10-B12). calibrate.ts and calibrate.test.ts
// still import these from here.
export { RawCaptureSchema, isFailed } from './capture/schemas'; // compat (W10-B23): remove when callers move
export type { RawCapture } from './capture/schemas'; // compat (W10-B23): remove when callers move
