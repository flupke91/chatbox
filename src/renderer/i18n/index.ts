import i18n, { type BackendModule, type ReadCallback } from 'i18next'
import { initReactI18next } from 'react-i18next'

import { authErrorOverrides } from './auth-error-overrides'
import changelogEn from './changelogs/changelog_en'
import changelogZhHans from './changelogs/changelog_zh_Hans'
import changelogZhHant from './changelogs/changelog_zh_Hant'
import en from './locales/en/translation.json'
import zhHans from './locales/zh-Hans/translation.json'

const localeLoaders: Record<string, () => Promise<{ default: Record<string, string> }>> = {
  'zh-Hant': () => import('./locales/zh-Hant/translation.json'),
  ja: () => import('./locales/ja/translation.json'),
  ko: () => import('./locales/ko/translation.json'),
  ru: () => import('./locales/ru/translation.json'),
  de: () => import('./locales/de/translation.json'),
  fr: () => import('./locales/fr/translation.json'),
  'pt-PT': () => import('./locales/pt-PT/translation.json'),
  es: () => import('./locales/es/translation.json'),
  ar: () => import('./locales/ar/translation.json'),
  'it-IT': () => import('./locales/it-IT/translation.json'),
  sv: () => import('./locales/sv/translation.json'),
  'nb-NO': () => import('./locales/nb-NO/translation.json'),
  tr: () => import('./locales/tr/translation.json'),
}

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(language: string, _namespace: string, callback: ReadCallback) {
    const loader = localeLoaders[language]
    if (!loader) {
      callback(null, {})
      return
    }
    loader()
      .then((mod) => {
        const override = authErrorOverrides[language as keyof typeof authErrorOverrides]
        callback(null, override ? { ...mod.default, ...override } : mod.default)
      })
      .catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), null)
      })
  },
}

void i18n
  .use(lazyLocaleBackend)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-Hans': {
        translation: { ...zhHans, ...authErrorOverrides['zh-Hans'] },
      },
      en: {
        translation: { ...en, ...authErrorOverrides.en },
      },
    },
    partialBundledLanguages: true,
    fallbackLng: 'en',

    interpolation: {
      escapeValue: false,
    },

    detection: {
      caches: [],
    },
  })

export default i18n

export function changelog() {
  switch (i18n.language) {
    case 'zh-Hans':
      return changelogZhHans
    case 'zh-Hant':
      return changelogZhHant
    case 'en':
      return changelogEn
    default:
      return changelogEn
  }
}
