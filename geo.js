"use strict";

// 下絵の画像のピクセル (u, v) と、eki-navi の共通座標 (x = 東, z = 北, メートル。原点 35.69/139.70) の間の変換。
// 変換は1次（アフィン）: x = a*u + b*v + c、z = d*u + e*v + f
// 国交省の画像は回転なし・縮尺一定。JR の構内図は calibrate.html で目印を合わせて求める
const Geo = {
  toWorld(t, u, v) {
    return { x: t.a * u + t.b * v + t.c, z: t.d * u + t.e * v + t.f };
  },

  toPixel(t, x, z) {
    const det = t.a * t.e - t.b * t.d;
    const dx = x - t.c;
    const dz = z - t.f;
    return { u: (t.e * dx - t.b * dz) / det, v: (-t.d * dx + t.a * dz) / det };
  },

  // 画像の上の向き (du, dv) を、方位（北 = 0、時計回り、度）にする
  azimuthOf(t, du, dv) {
    const dx = t.a * du + t.b * dv;
    const dz = t.d * du + t.e * dv;
    return (((Math.atan2(dx, dz) * 180) / Math.PI) % 360 + 360) % 360;
  },

  // 方位を、画像の上の回転（上 = 0、時計回り、度。SVG の rotate に渡す）にする
  screenAngleOf(t, azimuth) {
    const rad = (azimuth * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dz = Math.cos(rad);
    const det = t.a * t.e - t.b * t.d;
    const du = (t.e * dx - t.b * dz) / det;
    const dv = (-t.d * dx + t.a * dz) / det;
    return (Math.atan2(du, -dv) * 180) / Math.PI;
  },

  // 1px が何 m か（縦横の平均）
  metersPerPixel(t) {
    return Math.sqrt(Math.abs(t.a * t.e - t.b * t.d));
  },

  // 目印の組 [{u, v, x, z}] から最小二乗で変換を求める（3組以上）
  fit(pairs) {
    if (pairs.length < 3) {
      return null;
    }
    // 正規方程式 (A^T A) p = A^T y を、x と z のそれぞれで解く
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const bx = [0, 0, 0];
    const bz = [0, 0, 0];
    for (const p of pairs) {
      const r = [p.u, p.v, 1];
      for (let i = 0; i < 3; i += 1) {
        for (let j = 0; j < 3; j += 1) {
          m[i][j] += r[i] * r[j];
        }
        bx[i] += r[i] * p.x;
        bz[i] += r[i] * p.z;
      }
    }
    const solve = (a, b) => {
      const n = a.map((row, i) => [...row, b[i]]);
      for (let c = 0; c < 3; c += 1) {
        let pivot = c;
        for (let r = c + 1; r < 3; r += 1) {
          if (Math.abs(n[r][c]) > Math.abs(n[pivot][c])) pivot = r;
        }
        [n[c], n[pivot]] = [n[pivot], n[c]];
        if (Math.abs(n[c][c]) < 1e-12) return null;
        for (let r = 0; r < 3; r += 1) {
          if (r === c) continue;
          const f = n[r][c] / n[c][c];
          for (let k = c; k < 4; k += 1) n[r][k] -= f * n[c][k];
        }
      }
      return [n[0][3] / n[0][0], n[1][3] / n[1][1], n[2][3] / n[2][2]];
    };
    const px = solve(m, bx);
    const pz = solve(m, bz);
    if (!px || !pz) {
      return null;
    }
    return { a: px[0], b: px[1], c: px[2], d: pz[0], e: pz[1], f: pz[2] };
  },
};
