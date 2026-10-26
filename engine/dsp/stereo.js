/**
 * Stereo image control: mid/side width, balance, mono fold-down.
 * Width applies to the side signal only; mono compatibility is preserved by
 * construction (no all-pass/comb phase tricks).
 */
export class StereoProcessor {
  constructor(params = {}) {
    this.setParams(params);
  }

  setParams(p = {}) {
    const num = (v, lo, hi, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    this.params = {
      width: num(p.width, 0, 2, 1), // 0 = mono, 1 = normal, 2 = +6 dB side
      balance: num(p.balance, -1, 1, 0), // -1 = full L … +1 = full R
      mono: p.mono === true
    };
    // equal-power-ish balance gains
    const b = this.params.balance;
    this._gl = Math.cos(((b + 1) * Math.PI) / 4);
    this._gr = Math.sin(((b + 1) * Math.PI) / 4);
    // normalize so center = 1
    const norm = Math.SQRT1_2;
    this._gl /= norm;
    this._gr /= norm;
  }

  processBlock(L, R = L, offset = 0, len = L.length - offset) {
    const { width, mono } = this.params;
    const gl = this._gl;
    const gr = this._gr;
    const end = offset + len;

    if (R === L && !mono && width === 1 && gl === 1) return;

    for (let i = offset; i < end; i++) {
      const l = L[i];
      const r = R === L ? l : R[i];
      const m = 0.5 * (l + r);
      const s = 0.5 * (l - r);
      const sOut = mono ? 0 : s * width;
      let lo = m + sOut;
      let ro = m - sOut;
      lo *= gl;
      ro *= gr;
      L[i] = lo;
      if (R !== L) R[i] = ro;
      else L[i] = 0.5 * (lo + ro); // mono buffer: fold to mid
    }
  }
}
