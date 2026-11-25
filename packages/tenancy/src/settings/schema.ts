/** Levels a setting can come from. */
export type SettingsLevel = 'practice' | 'location' | 'facility' | 'surgeon';

export type SettingValue = string | number | boolean | null;

export type SettingsCategory = 'prep' | 'identity' | 'preferences';

/** Highest precedence first. A level not listed for a category is ignored for it. */
export const CATEGORY_PRECEDENCE: Readonly<Record<SettingsCategory, readonly SettingsLevel[]>> = {
  // Facility wins for prep and arrival instructions.
  prep: ['facility', 'location', 'practice'],
  // Location wins for patient-facing identity (name, number, hours).
  identity: ['location', 'practice'],
  // Surgeon wins for case preferences.
  preferences: ['surgeon', 'facility', 'location', 'practice'],
};

/** Category of each known setting key. Unknown keys are treated as `preferences`. */
export const SETTING_CATEGORIES: Readonly<Record<string, SettingsCategory>> = {
  npoHours: 'prep',
  prepInstructions: 'prep',
  arrivalInstructions: 'prep',
  arrivalLeadMinutes: 'prep',
  displayName: 'identity',
  phoneNumber: 'identity',
  businessHours: 'identity',
  preferredAnesthesia: 'preferences',
  preferredBlockMinutes: 'preferences',
};

export function categoryOf(key: string): SettingsCategory {
  return Object.hasOwn(SETTING_CATEGORIES, key) ? SETTING_CATEGORIES[key]! : 'preferences';
}

/** Settings stored at one level, with the ID of the record that holds them. */
export interface SettingsLayer {
  id: string;
  settings: Readonly<Record<string, SettingValue | undefined>>;
}

/** The layers that apply to one case. Missing layers are simply absent. */
export interface CaseContext {
  practice: SettingsLayer;
  location?: SettingsLayer;
  facility?: SettingsLayer;
  surgeon?: SettingsLayer;
}

export interface ResolvedSetting {
  value: SettingValue;
  source: SettingsLevel;
  sourceId: string;
}

export type ResolvedConfig = Record<string, ResolvedSetting>;
