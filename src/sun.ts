import * as THREE from 'three';

/**
 * Sun position for a site (simple NOAA-style approximation, good to ~1 deg).
 * Returns azimuth (deg, clockwise from north) and elevation (deg).
 * `localHour` is Polish clock time (CET in winter, CEST from the last Sunday of March to the last Sunday of October).
 */
export function sunPosition(lat: number, lon: number, month: number, day: number, localHour: number) {
  const date = new Date(Date.UTC(2026, month - 1, day));
  const n = Math.round((date.getTime() - Date.UTC(2026, 0, 0)) / 86400000);
  const g = (2 * Math.PI / 365) * (n - 1 + (localHour - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const summer = month > 3 && month < 10 || (month === 3 && day >= 29) || (month === 10 && day < 25);
  const utc = localHour - (summer ? 2 : 1);
  const solarMin = utc * 60 + eqTime + 4 * lon;
  const H = THREE.MathUtils.degToRad(solarMin / 4 - 180);
  const phi = THREE.MathUtils.degToRad(lat);
  const sinEl = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H);
  const el = Math.asin(sinEl);
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI;
  return { azimuth: THREE.MathUtils.radToDeg(az), elevation: THREE.MathUtils.radToDeg(el) };
}

/** Unit vector towards a direction (bearing deg, elevation deg) in world coords (x = plan x, z = plan y, y up). */
export function bearingToWorld(bearingDeg: number, elevationDeg: number, planDownBearingDeg: number): THREE.Vector3 {
  const d = THREE.MathUtils.degToRad(bearingDeg - planDownBearingDeg);
  const e = THREE.MathUtils.degToRad(elevationDeg);
  // plan +y has bearing B, plan +x has bearing B - 90
  return new THREE.Vector3(-Math.sin(d) * Math.cos(e), Math.sin(e), Math.cos(d) * Math.cos(e)).normalize();
}
