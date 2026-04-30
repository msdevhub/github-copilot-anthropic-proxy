// Test integer-scaled pricing math directly (no DB).
// Reproduces the same algorithm as lib/pricing.mjs computeCost.
function computeCost(in_mult, out_mult, inT, outT) {
  const inMilli  = Math.round(Math.max(0, Math.floor(inT))  * (Number(in_mult)  || 0) * 1000);
  const outMilli = Math.round(Math.max(0, Math.floor(outT)) * (Number(out_mult) || 0) * 1000);
  return Math.max(0, Math.ceil((inMilli + outMilli) / 1000));
}

let pass = 0, fail = 0;
function expect(name, got, want) {
  if (got === want) { pass++; console.log(`  ✓ ${name}: ${got}`); }
  else { fail++; console.error(`  ✗ ${name}: got=${got} want=${want}`); }
}

const cases = [
  ["0.06+0.04 small",   0.06, 0.04,    100,    50],
  ["0.06+0.04 large",   0.06, 0.04, 100000, 50000],
  ["0.1+0.5",           0.1,  0.5,   1234,  5678],
  ["0.333+0.667",       0.333, 0.667, 9999, 9999],
  ["1.5+5",             1.5,  5,    1000,  2000],
  ["0.001+0.002",       0.001, 0.002, 1500, 2500],
  ["1.0+5.0",           1,    5,     500,   500],
  ["3.14+2.71",         3.14, 2.71,  4096, 1024],
  ["0.06+0.04 huge",    0.06, 0.04, 1_000_000, 500_000],
  ["zero",              1,    1,       0,     0],
];

for (const [name, im, om, it, ot] of cases) {
  // "Want" = the math intended (ceil of true real product); within 1-token tolerance to old impl.
  const trueVal = Math.ceil(it * im + ot * om);
  expect(name, computeCost(im, om, it, ot), trueVal);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
