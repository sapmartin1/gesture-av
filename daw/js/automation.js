// automation.js — per-track parameter automation (arrangement mode).
// A track has one automation lane: {param, points:[{bar, v}]} with v in 0..1.

export const AUTO_PARAMS = {
  cutoff: { label: "filter cutoff", denorm: (v) => 100 + Math.pow(v, 2) * 17900 },
  vol:    { label: "volume",        denorm: (v) => v * 1.2 },
  reverb: { label: "reverb send",   denorm: (v) => v * 0.9 },
};

export function emptyAuto() { return { param: null, points: [] }; }

export function togglePoint(auto, bar, v, tolBar = 0.4) {
  const hit = auto.points.find((p) => Math.abs(p.bar - bar) < tolBar);
  if (hit && Math.abs(hit.v - v) < 0.18) {
    auto.points.splice(auto.points.indexOf(hit), 1);      // click near a point = remove
  } else if (hit) {
    hit.v = v;                                            // same bar, new value = move
  } else {
    auto.points.push({ bar, v });
    auto.points.sort((a, b) => a.bar - b.bar);
  }
}
