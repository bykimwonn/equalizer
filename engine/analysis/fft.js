/**
 * Iterative radix-2 FFT with precomputed twiddles and bit-reversal table.
 * Allocation-free transform() on preallocated buffers.
 */
export class FFT {
  constructor(size) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new RangeError('FFT size must be a power of two');
    }
    this.size = size;
    this.levels = Math.round(Math.log2(size));
    this.cosTable = new Float64Array(size / 2);
    this.sinTable = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let j = 0; j < this.levels; j++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      this.rev[i] = r;
    }
  }

  /**
   * In-place complex FFT. re/im are Float32Array|Float64Array of length size.
   * inverse=true computes the unnormalized inverse (caller scales by 1/N).
   */
  transform(re, im, inverse = false) {
    const n = this.size;
    if (re.length < n || im.length < n) throw new RangeError('buffers too small');
    // bit reversal
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? -1 : 1;
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = this.cosTable[k];
          const s = sign * this.sinTable[k];
          const tre = re[l] * c + im[l] * s;
          const tim = -re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }
}

/** Hann window of length n (cached by length). */
const windowCache = new Map();
export function hannWindow(n) {
  let w = windowCache.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    windowCache.set(n, w);
  }
  return w;
}

/**
 * Compute magnitude spectrum of a real signal slice.
 * @param {FFT} fft preallocated FFT of size N
 * @param {Float32Array} re scratch (length N)
 * @param {Float32Array} im scratch (length N)
 * @param {Float32Array} magOut scratch (length N/2+1)
 * @param {Float32Array} input signal
 * @param {number} offset start index in input
 * @param {Float32Array|null} window optional window (length N)
 * @returns {Float32Array} magOut (linear magnitudes, coherent-gain compensated)
 */
export function magnitudeSpectrum(fft, re, im, magOut, input, offset = 0, window = null) {
  const n = fft.size;
  let wSum = 0;
  for (let i = 0; i < n; i++) {
    const w = window ? window[i] : 1;
    re[i] = (input[offset + i] || 0) * w;
    im[i] = 0;
    wSum += w;
  }
  fft.transform(re, im, false);
  const norm = 2 / Math.max(1e-9, wSum); // amplitude compensation for coherent sine
  for (let k = 0; k <= n / 2; k++) {
    magOut[k] = Math.hypot(re[k], im[k]) * norm;
  }
  return magOut;
}
