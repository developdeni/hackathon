import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Lang = 'ru' | 'kk';

const STORAGE_KEY = '@tanap/lang';

type Dict = Record<string, string>;

// Russian is the source of truth; Kazakh mirrors the same keys.
const ru: Dict = {
  // Bottom navigation
  'nav.ai': 'AI Tools',
  'nav.fields': 'Участки',
  'nav.profile': 'Профиль',

  // AI Tools menu
  'ai.title': 'AI Tools',
  'ai.subtitle': 'Помощник агронома Tanap AI',
  'ai.photo.title': 'Распознавание по фото',
  'ai.photo.sub': 'Визуальная гипотеза по фото: болезни, вредители и сорняки. Не лабораторный диагноз.',
  'ai.count.title': 'Подсчёт всходов и густоты',
  'ai.count.sub': 'Визуальный подсчёт всходов; плотность на м² только с измеренной площадью кадра.',
  'ai.grain.title': 'Визуальный разбор зерна',
  'ai.grain.sub': 'Предварительная оценка видимых примесей и повреждений. Не заменяет лабораторию.',
  'ai.herd.title': 'Подсчёт поголовья скота',
  'ai.herd.sub': 'Визуальная оценка числа видимых животных по фото стада или кадру с дрона.',
  'ai.chat.title': 'AI Агроном',
  'ai.chat.sub': 'Чат-консультант по агрономии Акмолинской области: болезни, СЗР, сроки, нормы.',

  // Fields view
  'fields.title': 'Участки',
  'fields.noProfile': 'Профиль не выбран',
  'fields.online': 'Онлайн',
  'fields.offline': 'Офлайн',
  'fields.stat.fields': 'участков',
  'fields.stat.ha': 'га',
  'fields.stat.inspections': 'осмотров',
  'fields.add': 'Добавить участок',
  'fields.refresh': 'Обновить',
  'fields.listLabel': 'СПИСОК УЧАСТКОВ',
  'fields.holdToDelete': 'удержите для удаления',
  'fields.empty.title': 'Нет участков в этом профиле',
  'fields.empty.sub': 'Добавьте первое поле вручную или распознайте контур со спутника Sentinel-2.',
  'fields.addProfile': '+ профиль',

  // Profile screen
  'profile.title': 'Мой профиль',
  'profile.subtitle': 'Учётная запись агронома',
  'profile.newProfile': '+ Создать новый профиль хозяйства',
  'profile.accountData': 'ДАННЫЕ АККАУНТА',
  'profile.stat.fields': 'участков',
  'profile.stat.ha': 'га',
  'profile.stat.inspections': 'осмотров',
  'profile.stat.profiles': 'профилей',
  'profile.account': 'АККАУНТ',
  'profile.email': 'Email',
  'profile.org': 'Организация',
  'profile.region': 'Регион',
  'profile.registered': 'Дата регистрации',
  'profile.logout': 'Выйти из аккаунта',
  'profile.language': 'ЯЗЫК',
  'profile.linkTelegram': 'Привязать Telegram',
  'profile.linkTelegram.sub': 'Открыть бота и связать аккаунт одним нажатием',
  'profile.linkTelegram.error': 'Не удалось создать код привязки. Повторите позже.',
  'lang.ru': 'Русский',
  'lang.kk': 'Қазақша',
};

const kk: Dict = {
  'nav.ai': 'AI құралдар',
  'nav.fields': 'Алқаптар',
  'nav.profile': 'Профиль',

  'ai.title': 'AI құралдар',
  'ai.subtitle': 'Tanap AI агроном көмекшісі',
  'ai.photo.title': 'Фото арқылы тану',
  'ai.photo.sub': 'Фото бойынша визуалды болжам: аурулар, зиянкестер және арамшөптер. Зертханалық диагноз емес.',
  'ai.count.title': 'Көгіс пен тығыздықты санау',
  'ai.count.sub': 'Көгістердің визуалды саны; м²-ге тығыздық тек кадр ауданы өлшенгенде.',
  'ai.grain.title': 'Астықты визуалды талдау',
  'ai.grain.sub': 'Көрінетін қоспалар мен зақымданулардың алдын ала бағасы. Зертхананы алмастырмайды.',
  'ai.herd.title': 'Мал басын санау',
  'ai.herd.sub': 'Отар фотосы немесе дрон кадры бойынша көрінетін малдың визуалды бағасы.',
  'ai.chat.title': 'AI Агроном',
  'ai.chat.sub': 'Ақмола облысы агрономиясы бойынша чат-кеңесші: аурулар, ӨҚҚ, мерзімдер, нормалар.',

  'fields.title': 'Алқаптар',
  'fields.noProfile': 'Профиль таңдалмаған',
  'fields.online': 'Онлайн',
  'fields.offline': 'Офлайн',
  'fields.stat.fields': 'алқап',
  'fields.stat.ha': 'га',
  'fields.stat.inspections': 'тексеру',
  'fields.add': 'Алқап қосу',
  'fields.refresh': 'Жаңарту',
  'fields.listLabel': 'АЛҚАПТАР ТІЗІМІ',
  'fields.holdToDelete': 'жою үшін басып тұрыңыз',
  'fields.empty.title': 'Бұл профильде алқаптар жоқ',
  'fields.empty.sub': 'Бірінші алқапты қолмен қосыңыз немесе Sentinel-2 арқылы контурды анықтаңыз.',
  'fields.addProfile': '+ профиль',

  'profile.title': 'Менің профилім',
  'profile.subtitle': 'Агроном есептік жазбасы',
  'profile.newProfile': '+ Жаңа шаруашылық профилін құру',
  'profile.accountData': 'ЕСЕПТІК ЖАЗБА ДЕРЕКТЕРІ',
  'profile.stat.fields': 'алқап',
  'profile.stat.ha': 'га',
  'profile.stat.inspections': 'тексеру',
  'profile.stat.profiles': 'профиль',
  'profile.account': 'ЕСЕПТІК ЖАЗБА',
  'profile.email': 'Email',
  'profile.org': 'Ұйым',
  'profile.region': 'Аймақ',
  'profile.registered': 'Тіркелген күні',
  'profile.logout': 'Аккаунттан шығу',
  'profile.language': 'ТІЛ',
  'profile.linkTelegram': 'Telegram байланыстыру',
  'profile.linkTelegram.sub': 'Ботты ашып, аккаунтты бір рет басып байланыстыру',
  'profile.linkTelegram.error': 'Байланыстыру кодын жасау мүмкін болмады. Кейінірек қайталаңыз.',
  'lang.ru': 'Русский',
  'lang.kk': 'Қазақша',
};

const TABLES: Record<Lang, Dict> = { ru, kk };

type I18nValue = {
  lang: Lang;
  setLang: (next: Lang) => void;
  t: (key: string) => string;
};

const I18nContext = createContext<I18nValue>({
  lang: 'ru',
  setLang: () => {},
  t: (key: string) => ru[key] ?? key,
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('ru');

  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved === 'ru' || saved === 'kk') setLangState(saved);
      } catch {
        // ignore — default ru
      }
    })();
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  }, []);

  const t = useCallback(
    (key: string) => TABLES[lang][key] ?? ru[key] ?? key,
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
