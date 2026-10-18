import type { Component } from './db';

export interface KindPreset {
  label: string;
  lifespanKm?: number;
  lifespanDays?: number;
  serviceIntervalKm?: number;
  /** Battery life in hours of riding. */
  batteryHours?: number;
}

/** Sensible starting points; every value can be changed per component. */
export const COMPONENT_KINDS: Record<string, KindPreset> = {
  chain: { label: 'Chain', lifespanKm: 3000, serviceIntervalKm: 300 },
  tire_front: { label: 'Front tire', lifespanKm: 5000 },
  tire_rear: { label: 'Rear tire', lifespanKm: 3500 },
  sealant: { label: 'Tubeless sealant', lifespanDays: 120 },
  cassette: { label: 'Cassette', lifespanKm: 10000 },
  chainring: { label: 'Chainring(s)', lifespanKm: 20000 },
  brake_pads_front: { label: 'Brake pads (front)', lifespanKm: 2500 },
  brake_pads_rear: { label: 'Brake pads (rear)', lifespanKm: 2500 },
  rotors: { label: 'Brake rotors', lifespanKm: 15000 },
  brake_fluid: { label: 'Brake fluid', lifespanDays: 365 },
  cables: { label: 'Cables & housing', lifespanKm: 10000, lifespanDays: 730 },
  bar_tape: { label: 'Bar tape', lifespanKm: 8000, lifespanDays: 365 },
  jockey_wheels: { label: 'Jockey wheels', lifespanKm: 15000 },
  bottom_bracket: { label: 'Bottom bracket', lifespanKm: 15000 },
  // Electronics: tracked by battery, in hours of riding. Rough starting points; check your device's spec.
  shifters: { label: 'Shifters (electronic)', batteryHours: 500 },
  derailleur: { label: 'Derailleur (electronic)', batteryHours: 50 },
  power_meter: { label: 'Power meter', batteryHours: 200 },
  speed_sensor: { label: 'Speed sensor', batteryHours: 300 },
  cadence_sensor: { label: 'Cadence sensor', batteryHours: 300 },
  other: { label: 'Other' },
};

export function kindLabel(kind: string): string {
  return COMPONENT_KINDS[kind]?.label ?? kind;
}

/** Electronic parts: tracked only by battery hours (and optionally age), never by kilometres. */
export function isBatteryKind(kind: string): boolean {
  return COMPONENT_KINDS[kind]?.batteryHours != null;
}

/** Kilometre fields that battery-only parts must not have. */
export const NO_KM_LIMITS = { lifespan_km: null, service_interval_km: null } as const;

export type Level = 'ok' | 'soon' | 'due' | 'none';

export interface ComponentStatus {
  km: number;
  days: number;
  kmSinceService: number | null;
  /** Hours ridden since the battery was last changed (or since install), when a battery is tracked. */
  hoursSinceBattery: number | null;
  /** Highest of the wear / age / service / battery ratios, or null when nothing is tracked. */
  ratio: number | null;
  level: Level;
  reason: string | null;
}

const DAY_MS = 86_400_000;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS));
}

/**
 * @param batteryRideSeconds riding time on the bike since the last battery change, from
 *   `batteryRideSeconds()`; only needed for components that track a battery.
 */
export function componentStatus(c: Component, bikeOdometerM: number, batteryRideSeconds = 0): ComponentStatus {
  const endOdo = c.removed_odometer_m ?? bikeOdometerM;
  const km = Math.max(0, endOdo - c.installed_odometer_m + c.initial_m) / 1000;
  const days = daysBetween(c.installed_on, c.removed_on ?? today());
  const kmSinceService =
    c.service_interval_km != null
      ? Math.max(0, endOdo - (c.last_service_odometer_m ?? c.installed_odometer_m)) / 1000
      : null;
  const hoursSinceBattery = c.battery_interval_hours != null || c.battery_type ? batteryRideSeconds / 3600 : null;

  const candidates: [number, string][] = [];
  if (c.lifespan_km) candidates.push([km / c.lifespan_km, 'wear']);
  if (c.lifespan_days) candidates.push([days / c.lifespan_days, 'age']);
  if (c.service_interval_km && kmSinceService != null)
    candidates.push([kmSinceService / c.service_interval_km, 'service']);
  if (c.battery_interval_hours && hoursSinceBattery != null)
    candidates.push([hoursSinceBattery / c.battery_interval_hours, 'battery']);

  if (candidates.length === 0)
    return { km, days, kmSinceService, hoursSinceBattery, ratio: null, level: 'none', reason: null };
  const [ratio, reason] = candidates.reduce((a, b) => (b[0] > a[0] ? b : a));
  const level: Level = ratio >= 1 ? 'due' : ratio >= 0.8 ? 'soon' : 'ok';
  return { km, days, kmSinceService, hoursSinceBattery, ratio, level, reason };
}

export function formatKm(km: number): string {
  return `${Math.round(km).toLocaleString('en-GB')} km`;
}
