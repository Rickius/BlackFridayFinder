// Distance between two { lat, lon } points, in miles.
const EARTH_RADIUS_MILES = 3958.8;
const radians = (degrees) => (degrees * Math.PI) / 180;

export function haversineMiles(a, b) {
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}
