const test = require('node:test');
const assert = require('node:assert/strict');
const { createHardwareProbe } = require('../src/core/brain/hardware');

const os = {
  cpus: () => Array.from({ length: 12 }, () => ({ model: 'AMD Ryzen 5 5600X 6-Core Processor             ' })),
  totalmem: () => 17079869440, release: () => '10.0.22631', platform: () => 'win32',
};

test('hardware: CPU, RAM, Windows 11, GPU with VRAM from nvidia-smi; cached', async () => {
  let runs = 0;
  const exec = async (cmd, args) => { runs++; assert.equal(cmd, 'nvidia-smi'); assert.ok(args.includes('--format=csv,noheader,nounits')); return 'NVIDIA GeForce RTX 3050, 8192\n'; };
  const probe = createHardwareProbe({ os, exec });
  const hw = await probe.get();
  assert.deepEqual(hw, { cpu: 'AMD Ryzen 5 5600X 6-Core Processor (12 threads)', ramGB: 15.9, gpu: 'NVIDIA GeForce RTX 3050, 8 GB VRAM', os: 'Windows 11 (build 22631)' });
  await probe.get();
  assert.equal(runs, 1);
  assert.equal(probe.cached().gpu, 'NVIDIA GeForce RTX 3050, 8 GB VRAM');
});

test('hardware: no nvidia-smi → falls back to the Windows video controller name, never throws', async () => {
  const exec = async cmd => { if (cmd === 'nvidia-smi') throw new Error('ENOENT'); return 'AMD Radeon RX 6600\r\n'; };
  const hw = await createHardwareProbe({ os, exec }).get();
  assert.equal(hw.gpu, 'AMD Radeon RX 6600');
  const none = await createHardwareProbe({ os, exec: async () => { throw new Error('nope'); } }).get();
  assert.equal(none.gpu, undefined);
  assert.equal(none.cpu.includes('5600X'), true);
});
