// Physical constants (CODATA 2018, SI). Exact values have no uncertainty.
const CONSTANTS = [
  ['speed of light in vacuum', 'c', 299792458, 'm/s'],
  ['Planck constant', 'h', 6.62607015e-34, 'J s'],
  ['reduced Planck constant', 'hbar ħ', 1.054571817e-34, 'J s'],
  ['elementary charge', 'e q_e', 1.602176634e-19, 'C'],
  ['Boltzmann constant', 'k k_B kB', 1.380649e-23, 'J/K'],
  ['Avogadro constant', 'N_A NA', 6.02214076e23, '1/mol'],
  ['molar gas constant', 'R', 8.314462618, 'J/(mol K)'],
  ['Newtonian gravitational constant', 'G', 6.67430e-11, 'm^3/(kg s^2)', 1.5e-15],
  ['standard acceleration of gravity', 'g g0 g_n', 9.80665, 'm/s^2'],
  ['vacuum electric permittivity', 'epsilon_0 ε0 eps0', 8.8541878128e-12, 'F/m', 1.3e-21],
  ['vacuum magnetic permeability', 'mu_0 μ0 mu0', 1.25663706212e-6, 'N/A^2', 1.9e-16],
  ['electron mass', 'm_e me', 9.1093837015e-31, 'kg', 2.8e-40],
  ['proton mass', 'm_p mp', 1.67262192369e-27, 'kg', 5.1e-37],
  ['neutron mass', 'm_n mn', 1.67492749804e-27, 'kg', 9.5e-37],
  ['atomic mass constant', 'u m_u amu', 1.66053906660e-27, 'kg', 5.0e-37],
  ['fine-structure constant', 'alpha α', 7.2973525693e-3, '', 1.1e-12],
  ['Rydberg constant', 'R_inf R∞', 10973731.568160, '1/m', 2.1e-5],
  ['Bohr radius', 'a_0 a0', 5.29177210903e-11, 'm', 8.0e-21],
  ['Stefan-Boltzmann constant', 'sigma σ', 5.670374419e-8, 'W/(m^2 K^4)'],
  ['Wien wavelength displacement constant', 'b', 2.897771955e-3, 'm K'],
  ['Faraday constant', 'F', 96485.33212, 'C/mol'],
  ['standard atmosphere', 'atm', 101325, 'Pa'],
  ['electron volt', 'eV', 1.602176634e-19, 'J'],
  ['Coulomb constant', 'k_e ke', 8.9875517923e9, 'N m^2/C^2', 1.4e0],
  ['Bohr magneton', 'mu_B μB', 9.2740100783e-24, 'J/T', 2.8e-33],
  ['Earth mass', 'M_earth M⊕', 5.9722e24, 'kg', 6e20],
  ['Earth mean radius', 'R_earth R⊕', 6.371e6, 'm'],
  ['Sun mass', 'M_sun M☉', 1.98847e30, 'kg', 7e25],
  ['astronomical unit', 'au AU', 149597870700, 'm'],
  ['light year', 'ly', 9460730472580800, 'm'],
  ['absolute zero', 'T0', -273.15, '°C'],
].map(([name, symbols, value, unit, uncertainty]) => ({ name, symbols: symbols.split(' '), value, unit, uncertainty: uncertainty ?? 0 }));

const norm = s => String(s).toLowerCase().replace(/[\s_\-]+/g, ' ').trim();

function lookup(query) {
  const q = String(query).trim();
  const bySymbol = CONSTANTS.find(c => c.symbols.includes(q));
  if (bySymbol) return bySymbol;
  const nq = norm(q);
  const byName = CONSTANTS.find(c => norm(c.name) === nq) || CONSTANTS.find(c => c.symbols.some(s => norm(s) === nq));
  if (byName) return byName;
  const words = nq.split(' ').filter(w => w.length > 1 && !['of', 'the', 'in', 'constant'].includes(w));
  if (!words.length) return null;
  return CONSTANTS.find(c => words.every(w => norm(c.name).includes(w))) || null;
}

module.exports = { lookup, CONSTANTS };
