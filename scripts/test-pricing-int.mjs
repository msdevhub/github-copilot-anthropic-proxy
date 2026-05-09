// Test integer-scaled pricing math directly (no DB).
// Reproduces the same algorithm as lib/pricing.mjs computeCost.
function computeCost(in_mult, out_mult, inT, outT, crT = 0, cwT = 0, cr_mult = null, cw_mult = null) {
  const crM = cr_mult == null ? in_mult * 0.1  : cr_mult;
  const cwM = cw_mult == null ? in_mult * 1.25 : cw_mult;
  const inMilli  = Math.round(Math.max(0, Math.floor(inT))  * (Number(in_mult)  || 0) * 1000);
  const outMilli = Math.round(Math.max(0, Math.floor(outT)) * (Number(out_mult) || 0) * 1000);
  const crMilli  = Math.round(Math.max(0, Math.floor(crT))  * (Number(crM) || 0) * 1000);
  const cwMilli  = Math.round(Math.max(0, Math.floor(cwT))  * (Number(cwM) || 0) * 1000);
  return Math.max(0, Math.ceil((inMilli + outMilli + crMilli + cwMilli) / 1000));
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
  const trueVal = Math.ceil(it * im + ot * om);
  expect(name, computeCost(im, om, it, ot), trueVal);
}

// Cache-hit cases
console.log("\n— cache-hit billing —");
expect("sonnet-4-6 cache_read default",
  computeCost(3, 15, 900, 242, 128000, 0, 0.3, null),
  900*3 + 242*15 + 128000*0.3); // 2700+3630+38400 = 44730
expect("expected literal 44730",
  computeCost(3, 15, 900, 242, 128000, 0, 0.3, null), 44730);
expect("cache_write 1.25x",
  computeCost(2, 10, 1000, 100, 0, 800, null, 2.5),
  1000*2 + 100*10 + 800*2.5); // 2000+1000+2000 = 5000
expect("default cache mults from input",
  computeCost(2, 10, 1000, 100, 500, 200),
  1000*2 + 100*10 + 500*(2*0.1) + 200*(2*1.25)); // 2000+1000+100+500 = 3600

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
