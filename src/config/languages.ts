// src/config/languages.ts
// English names for language codes — used in prompts (Claude reviewer) and
// as folder names in the output layout (e.g. "French/25Sim01_01/French Clips").
// Codes are lowercase, as stored everywhere else.

export const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  ja: "Japanese",
  zh: "Chinese",
  ko: "Korean",
};

export const languageName = (code: string): string => LANGUAGE_NAMES[code] ?? code;
