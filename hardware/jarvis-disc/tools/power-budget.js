#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const input = process.argv[2] || path.join(__dirname, 'power-budget-template.json');
const data = JSON.parse(fs.readFileSync(input, 'utf8'));
const m = data.measurement || {};

function requiredNumber(key, min = 0) {
  const value = m[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(`measurement.${key} must be a measured number >= ${min}`);
  }
  return value;
}

const steadyA = requiredNumber('five_volt_steady_current_a');
const peakA = requiredNumber('five_volt_transient_peak_current_a');
const minimumV = requiredNumber('five_volt_minimum_voltage_v');
const pdV = requiredNumber('pd_input_voltage_v', 1);
const efficiency = requiredNumber('converter_efficiency_fraction', 0.01);
const headroomPct = requiredNumber('design_headroom_percent');

if (efficiency > 1) throw new Error('converter_efficiency_fraction must be <= 1');
if (headroomPct > 100) throw new Error('design_headroom_percent must be <= 100');
if (minimumV > 5.5) throw new Error('five_volt_minimum_voltage_v looks invalid for a nominal 5 V rail');

const nominalRailV = 5;
const steadyW = nominalRailV * steadyA;
const peakW = nominalRailV * peakA;
const designSteadyA = steadyA * (1 + headroomPct / 100);
const designSteadyW = nominalRailV * designSteadyA;
const designPeakA = peakA * (1 + headroomPct / 100);
const designPeakW = nominalRailV * designPeakA;
const pdInputW = designSteadyW / efficiency;
const pdInputA = pdInputW / pdV;
const pdTransientW = designPeakW / efficiency;
const pdTransientA = pdTransientW / pdV;

const report = {
  source: path.resolve(input),
  measured: {
    fiveVoltSteadyCurrentA: steadyA,
    fiveVoltSteadyPowerW: steadyW,
    fiveVoltTransientPeakCurrentA: peakA,
    fiveVoltTransientPeakPowerW: peakW,
    fiveVoltMinimumObservedVoltageV: minimumV
  },
  sizing: {
    configuredHeadroomPercent: headroomPct,
    minimumFiveVoltContinuousCurrentA: designSteadyA,
    minimumFiveVoltContinuousPowerW: designSteadyW,
    minimumFiveVoltTransientCurrentA: designPeakA,
    minimumFiveVoltTransientPowerW: designPeakW,
    estimatedPdContinuousInputPowerW: pdInputW,
    estimatedPdContinuousInputCurrentA: pdInputA,
    estimatedPdTransientInputPowerW: pdTransientW,
    estimatedPdTransientInputCurrentA: pdTransientA,
    negotiatedPdVoltageV: pdV,
    converterEfficiencyFraction: efficiency,
    measuredTransientPeakA: peakA
  },
  notes: [
    'Use the measured complete-system combined condition, not a sum of unrelated component peaks.',
    'The headroom setting is an engineering input, not a substitute for transient and thermal validation.',
    'Select converter and PD ratings from datasheets at the actual voltage, temperature, and airflow.',
    'Coordinate fuse, connector, cable, PCB copper, and wire ratings with measured fault and inrush behavior.'
  ]
};

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
