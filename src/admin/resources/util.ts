/**
 * A path id that is not a UUID would reach Postgres as
 * "invalid input syntax for type uuid" — a 500 for what is really a
 * missing page. Checked before any query so it is a 404.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Display labels for the database enums, shared by list and form views. */
export const FACILITY_TYPE_LABELS: Record<string, string> = {
  hospital: 'Hospital',
  primary_health_centre: 'Primary health centre',
  clinic: 'Clinic',
  pharmacy: 'Pharmacy',
  police_station: 'Police station',
  fire_station: 'Fire station',
  frsc: 'FRSC office',
  nscdc: 'NSCDC office',
};

export const FACT_CATEGORY_LABELS: Record<string, string> = {
  history: 'History',
  geography: 'Geography',
  government: 'Government',
  demographics: 'Demographics',
  culture: 'Culture',
};
