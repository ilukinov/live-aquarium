/* Генератор моделей рыб без купленного пака.
 *
 *   node tools/make-models.js
 *
 * Берёт боковой силуэт каждого вида из assets/coloring/manifest.json
 * (contourModel — тот же контур, по которому печатается лист) и «надувает»
 * его в объёмное тело: толщина растёт с расстоянием от края, так что тело
 * пухлое, а плавники тонкие. Силуэт модели совпадает с листом один в один,
 * поэтому листы и уже напечатанные раскраски остаются рабочими.
 *
 * Скелета нет — аквариум сам гнёт такие рыбы в шейдере. Ориентацию сцена
 * находит по габаритам: длина по Z (нос в +Z), спина по +Y, бок по X.
 *
 * На выходе: assets/models/pack/<вид>/<вид>.gltf (буфер внутри, base64)
 * и assets/models/pack/pack.json. Покупной пак, если он есть, затирается.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACK = path.join(ROOT, 'assets', 'models', 'pack');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'coloring', 'manifest.json'), 'utf8'));

const GRID = 110;          // узлов сетки по длине рыбы
const MAX_HALF = 0.085;    // предельная полутолщина, в длинах тела
const PUFF = 0.6;          // полутолщина = PUFF · (расстояние до края в центре тела)

// Цвета «готовых рыбок» из меню: раскрашенным их заменяет детский рисунок.
const COLORS = [[1, 0.5, 0.15], [0.2, 0.45, 0.95], [0.95, 0.8, 0.2], [0.95, 0.35, 0.4],
  [0.55, 0.3, 0.85], [0.25, 0.75, 0.85], [0.9, 0.9, 0.85], [0.6, 0.45, 0.3],
  [0.45, 0.6, 0.25], [0.95, 0.55, 0.7], [0.85, 0.85, 0.3], [0.3, 0.55, 0.5]];

function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// ближайшая точка контура и расстояние до неё
function nearest(poly, x, y) {
  let best = Infinity, bx = x, by = y;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [cx, cy] = poly[i];
    const dx = cx - ax, dy = cy - ay, L = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L));
    const px = ax + t * dx, py = ay + t * dy, d = (x - px) ** 2 + (y - py) ** 2;
    if (d < best) { best = d; bx = px; by = py; }
  }
  return { d: Math.sqrt(best), x: bx, y: by };
}

// Сетка над габаритом силуэта: узлы внутри — с толщиной, крайние снаружи —
// притянуты на контур с нулевой толщиной, чтобы край был гладким, а не лесенкой.
function buildFish(poly) {
  const zs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const z0 = Math.min(...zs), z1 = Math.max(...zs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const h = (z1 - z0) / GRID;
  const NZ = GRID + 3, NY = Math.ceil((y1 - y0) / h) + 3;
  const node = (i, j) => j * NZ + i;

  const isIn = new Uint8Array(NZ * NY), pz = [], py = [], dist = new Float32Array(NZ * NY);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NZ; i++) {
      const z = z0 + (i - 1) * h, y = y0 + (j - 1) * h, k = node(i, j);
      pz[k] = z; py[k] = y;
      if (inside(poly, z, y)) { isIn[k] = 1; dist[k] = nearest(poly, z, y).d; }
    }
  }
  let dmax = 0;
  for (let k = 0; k < dist.length; k++) dmax = Math.max(dmax, dist[k]);

  const used = new Uint8Array(NZ * NY);   // 1 — внутри, 2 — притянут на контур
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NZ; i++) {
      const k = node(i, j);
      if (isIn[k]) { used[k] = 1; continue; }
      let near = false;
      for (let dj = -1; dj <= 1 && !near; dj++) {
        for (let di = -1; di <= 1; di++) {
          const a = i + di, b = j + dj;
          if (a >= 0 && b >= 0 && a < NZ && b < NY && isIn[node(a, b)]) { near = true; break; }
        }
      }
      if (near) { const n = nearest(poly, pz[k], py[k]); pz[k] = n.x; py[k] = n.y; used[k] = 2; }
    }
  }

  // Толщина — надутая мембрана: решаем ∇²u = −1 внутри силуэта с u = 0 на
  // краю (как в скетч-моделлерах). Поле гладкое, без гребней по средней
  // линии, как у расстояния до края; корень делает сечение круглым.
  const u = new Float32Array(NZ * NY);
  for (let it = 0; it < 1500; it++) {
    for (let j = 1; j < NY - 1; j++) {
      for (let i = 1; i < NZ - 1; i++) {
        const k = node(i, j);
        if (used[k] !== 1) continue;
        const g = (u[k - 1] + u[k + 1] + u[k - NZ] + u[k + NZ] + h * h) / 4;
        u[k] += 1.9 * (g - u[k]);   // SOR
      }
    }
  }
  let umax = 0;
  for (let k = 0; k < u.length; k++) umax = Math.max(umax, u[k]);
  // полутолщина в центре тела — PUFF · dmax, но не толще MAX_HALF
  const peak = Math.min(MAX_HALF, PUFF * dmax);
  const thick = u.map((x) => peak * Math.sqrt(Math.max(0, x) / umax));
  const half = (k) => thick[k];

  // две стороны: +X и −X, у каждой свои вершины (свои нормали)
  const remap = new Int32Array(NZ * NY).fill(-1);
  const base = [];
  for (let k = 0; k < NZ * NY; k++) if (used[k]) { remap[k] = base.length; base.push(k); }
  const n = base.length;
  const pos = new Float32Array(n * 6);
  base.forEach((k, v) => {
    const t = half(k);
    pos.set([t, py[k], pz[k]], v * 3);
    pos.set([-t, py[k], pz[k]], (v + n) * 3);
  });

  const idx = [];
  for (let j = 0; j < NY - 1; j++) {
    for (let i = 0; i < NZ - 1; i++) {
      const a = node(i, j), b = node(i + 1, j), c = node(i + 1, j + 1), d = node(i, j + 1);
      if (!used[a] || !used[b] || !used[c] || !used[d]) continue;
      // квад целиком из притянутых узлов мостил бы вырезы (вилку хвоста)
      if (used[a] === 2 && used[b] === 2 && used[c] === 2 && used[d] === 2) continue;
      const A = remap[a], B = remap[b], C = remap[c], D = remap[d];
      idx.push(A, C, B, A, D, C);                         // сторона +X смотрит в +X
      idx.push(A + n, B + n, C + n, A + n, C + n, D + n); // сторона −X — в −X
    }
  }

  const nor = new Float32Array(pos.length);
  for (let f = 0; f < idx.length; f += 3) {
    const [a, b, c] = [idx[f] * 3, idx[f + 1] * 3, idx[f + 2] * 3];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const p of [a, b, c]) { nor[p] += nx; nor[p + 1] += ny; nor[p + 2] += nz; }
  }
  for (let p = 0; p < nor.length; p += 3) {
    const l = Math.hypot(nor[p], nor[p + 1], nor[p + 2]) || 1;
    nor[p] /= l; nor[p + 1] /= l; nor[p + 2] /= l;
  }
  return { pos, nor, idx: new Uint32Array(idx) };
}

function gltf(mesh, color) {
  const parts = [mesh.pos, mesh.nor, mesh.idx].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  const buf = Buffer.concat(parts);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let p = 0; p < mesh.pos.length; p += 3) {
    for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], mesh.pos[p + c]); max[c] = Math.max(max[c], mesh.pos[p + c]); }
  }
  const count = mesh.pos.length / 3;
  return {
    asset: { version: '2.0', generator: 'paper-aquarium tools/make-models.js' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'fish' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0.05, roughnessFactor: 0.55 }, doubleSided: true }],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: mesh.idx.length, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: parts[0].length, target: 34962 },
      { buffer: 0, byteOffset: parts[0].length, byteLength: parts[1].length, target: 34962 },
      { buffer: 0, byteOffset: parts[0].length + parts[1].length, byteLength: parts[2].length, target: 34963 }
    ],
    buffers: [{ byteLength: buf.length, uri: 'data:application/octet-stream;base64,' + buf.toString('base64') }]
  };
}

const list = [];
manifest.fish.forEach((f, i) => {
  const mesh = buildFish(f.contourModel);
  // самопроверка: габарит модели по (z, y) — это габарит контура, иначе
  // планарная развёртка сцены сдвинет рисунок относительно листа
  const ys = f.contourModel.map((p) => p[1]);
  const my = [Infinity, -Infinity];
  for (let p = 1; p < mesh.pos.length; p += 3) { my[0] = Math.min(my[0], mesh.pos[p]); my[1] = Math.max(my[1], mesh.pos[p]); }
  if (Math.abs(my[0] - Math.min(...ys)) > 1e-3 || Math.abs(my[1] - Math.max(...ys)) > 1e-3) {
    throw new Error(f.name + ': габарит модели разошёлся с контуром');
  }
  const url = f.model;
  const file = path.join(ROOT, url.replace(/^\//, ''));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(gltf(mesh, COLORS[i % COLORS.length])));
  list.push({ name: f.name, title: (f.titles && f.titles.ru) || f.title, url });
  console.log(f.name.padEnd(24), String(mesh.idx.length / 3).padStart(6), 'треугольников');
});
fs.writeFileSync(path.join(PACK, 'pack.json'), JSON.stringify(list, null, 1));
console.log('pack.json:', list.length, 'видов');
