/**
 * Synthetic, project-authored fixtures. They contain no upstream AMBER or
 * biomolecular data and are intentionally too small to support science claims.
 */
export const SYNTHETIC_MDOUT_COMPLETE = [
  "NSTEP = 100 TIME(PS) = 0.200 TEMP(K) = 3.001D+02 PRESS = 1.10",
  "Etot = -1.0D+03 EKtot = 2.0D+02 EPtot = -1.2D+03",
  "VOLUME = 9.5D+04 Density = 1.001",
  "NSTEP = 200 TIME(PS) = 0.400 TEMP(K) = 3.002D+02 PRESS = 0.95",
  "Etot = -1.1D+03 EKtot = 2.1D+02 EPtot = -1.31D+03",
  "VOLUME = 9.49D+04 Density = 1.002",
  "5.  TIMINGS",
  "",
].join("\n");

export const SYNTHETIC_MDINFO_PARTIAL = [
  "NSTEP = 200 TIME(PS) = 0.400 TEMP(K) = 3.002D+02 PRESS = 0.95",
  "Etot = -1.1D+03 EKtot = 2.1D+02 EPtot = -1.31D+03",
  "VOLUME = 9.49D+04 Density = 1.002",
  "",
].join("\n");

export const SYNTHETIC_MDOUT_SHAKE_FATAL = [
  "NSTEP = 5 TIME(PS) = 0.010 TEMP(K) = 999.0",
  "SHAKE cannot be accomplished",
  "5.  TIMINGS",
  "",
].join("\n");

export const SYNTHETIC_CPPTRAJ_WHITESPACE = [
  "#Frame LigandRMSD",
  "1 0.120",
  "2 0.180",
  "3 0.210",
  "",
].join("\n");

export const SYNTHETIC_CPPTRAJ_CSV = ["Frame,Distance", "1,3.10", "2,3.25", "3,3.20", ""].join(
  "\n",
);
