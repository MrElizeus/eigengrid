/**
 * Reviewed, immutable build profile, not a generic assertion about every sander.
 * Site installation/qualification is documented in the companion cluster repo.
 * A host gateway must still verify the actual executable digest before starting it.
 */
export const SANDER26_CPU_PROFILE = Object.freeze({
  executable: "sander",
  version: "26.0",
  binarySha256: "1aafc6f26d62e03f3237fd84fe2f829f28016a4a94ae08812a2312fdf18472d1",
  packageBuild: "cuda_None_nompi_py312hd652fd9_100",
  sourceSha256: "5d46eef3c2bb7d5bf9e8c0c38add34406ea67e3f0e4097ac9d11d8a544538c9c",
  shakeSourceSha256: "2ebebbed066ca821612d7e0dada3af434358af03adb2c98be5e74d8a30bf59c1",
  // shake.F90 starts nit=0, checks nit > 3000 BEFORE a sweep, then increments.
  // It can therefore perform 3001 bond sweeps. The failure message says 3000.
  // This is compiled into the engine, not a configurable &cntrl keyword.
  maximumShakeIterations: 3001,
  // AmberTools/src/include/md.h declares character(len=256) restraintmask.
  maximumRestraintMaskCharacters: 256,
  fastThreePointWater: true,
} as const);

/**
 * Exact Amber 26 CUDA SHAKE source mapping observed on Beast. This binds the
 * installed engine and compiled SHAKE loop bound; it does not qualify the
 * GPU/library/site runtime, which still needs an EigenGrid-dispatched test.
 * The site runner separately binds the GPU library tree and allocated device.
 */
export const PMEMD26_CUDA_PROFILE = Object.freeze({
  executable: "pmemd.cuda",
  version: "26.0",
  binarySha256: "8b98fc78493510c858447c7aceab469f7a2251e1a2301a748d9690f1359fd412",
  shakeKernelHeaderSha256: "5efba3d041f728df956ad720826cafe83323542742f13c186c624ca06d31bd74",
  maximumShakeIterations: 3000,
} as const);
