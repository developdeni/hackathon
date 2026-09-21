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

  // Profile editing
  'profile.edit': 'Редактировать профиль',
  'profile.emailVerified': 'подтверждён',
  'profile.emailUnverified': 'не подтверждён',
  'edit.title': 'Редактирование',
  'edit.section.info': 'ЛИЧНЫЕ ДАННЫЕ',
  'edit.section.email': 'ЭЛЕКТРОННАЯ ПОЧТА',
  'edit.name': 'Имя',
  'edit.org': 'Организация',
  'edit.region': 'Регион',
  'edit.email': 'Email',
  'edit.namePlaceholder': 'Ваше имя',
  'edit.orgPlaceholder': 'Название хозяйства',
  'edit.regionPlaceholder': 'Область / район',
  'edit.save': 'Сохранить изменения',
  'edit.saved': 'Профиль обновлён',
  'edit.error': 'Не удалось сохранить. Попробуйте ещё раз.',
  'edit.changeEmail': 'Сменить email',
  'edit.verifyEmail': 'Подтвердить email',
  'edit.newEmail': 'Новый email',
  'edit.emailNote': 'На указанный адрес придёт 6-значный код подтверждения.',
  'edit.sendCode': 'Отправить код',
  'edit.sending': 'Отправляем…',
  'edit.codeSentTo': 'Код отправлен на',
  'edit.enterCode': 'Код из письма',
  'edit.confirm': 'Подтвердить',
  'edit.confirming': 'Проверяем…',
  'edit.emailConfirmed': 'Email подтверждён',
  'edit.codeError': 'Неверный или просроченный код.',
  'edit.cancel': 'Отмена',
  'edit.devCodeNote': 'Почта-отправитель не настроена. Код для проверки:',
  'edit.invalidEmail': 'Введите корректный email',

  // Team / access (RBAC)
  'profile.myId': 'ВАШ ID',
  'profile.idHint': 'Дайте этот ID владельцу, чтобы он выдал вам доступ',
  'profile.copied': 'ID скопирован',
  'profile.team': 'Команда и доступы',
  'profile.invitations': 'Приглашения',
  'invite.from': 'Приглашает',
  'invite.accept': 'Принять',
  'invite.decline': 'Отклонить',
  'invite.wholeProfile': 'весь профиль',
  'invite.selectedFields': 'выбранные участки',
  'role.owner': 'Владелец',
  'role.member': 'Участник',
  'team.title': 'Команда',
  'team.subtitle': 'Выдавайте доступ к профилю и участкам',
  'team.chooseProfile': 'ПРОФИЛЬ',
  'team.invite': 'ПРИГЛАСИТЬ ПО ID',
  'team.idPlaceholder': 'ID участника, напр. TA-AB3D9K',
  'team.permissions': 'ЧТО РАЗРЕШИТЬ',
  'team.perm.view': 'Просмотр и аналитика',
  'team.perm.ai': 'AI-инструменты',
  'team.perm.edit': 'Добавлять и редактировать участки',
  'team.perm.inspect': 'Осмотры, агропаспорт, экспорт',
  'team.scope': 'ДОСТУП К УЧАСТКАМ',
  'team.scope.all': 'Все участки профиля',
  'team.scope.selected': 'Выбранные участки',
  'team.send': 'Отправить приглашение',
  'team.sent': 'Приглашение отправлено',
  'team.members': 'УЧАСТНИКИ И ПРИГЛАШЕНИЯ',
  'team.empty': 'Пока никого нет. Пригласите по ID выше.',
  'team.statusPending': 'ожидает принятия',
  'team.statusActive': 'активен',
  'team.revoke': 'Убрать',
  'team.leave': 'Выйти из профиля',
  'team.onlyOwner': 'Только владелец профиля может приглашать участников',
  'team.notFound': 'Пользователь с таким ID не найден',
  'team.selectFields': 'Отметьте участки',
  'team.error': 'Не удалось. Проверьте данные.',
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

  // Profile editing
  'profile.edit': 'Профильді өңдеу',
  'profile.emailVerified': 'расталған',
  'profile.emailUnverified': 'расталмаған',
  'edit.title': 'Өңдеу',
  'edit.section.info': 'ЖЕКЕ ДЕРЕКТЕР',
  'edit.section.email': 'ЭЛЕКТРОНДЫҚ ПОШТА',
  'edit.name': 'Аты',
  'edit.org': 'Ұйым',
  'edit.region': 'Аймақ',
  'edit.email': 'Email',
  'edit.namePlaceholder': 'Сіздің атыңыз',
  'edit.orgPlaceholder': 'Шаруашылық атауы',
  'edit.regionPlaceholder': 'Облыс / аудан',
  'edit.save': 'Өзгерістерді сақтау',
  'edit.saved': 'Профиль жаңартылды',
  'edit.error': 'Сақтау мүмкін болмады. Қайта көріңіз.',
  'edit.changeEmail': 'Email өзгерту',
  'edit.verifyEmail': 'Email растау',
  'edit.newEmail': 'Жаңа email',
  'edit.emailNote': 'Көрсетілген мекенжайға 6 таңбалы растау коды келеді.',
  'edit.sendCode': 'Код жіберу',
  'edit.sending': 'Жіберілуде…',
  'edit.codeSentTo': 'Код жіберілді:',
  'edit.enterCode': 'Хаттағы код',
  'edit.confirm': 'Растау',
  'edit.confirming': 'Тексерілуде…',
  'edit.emailConfirmed': 'Email расталды',
  'edit.codeError': 'Код қате немесе мерзімі өтті.',
  'edit.cancel': 'Болдырмау',
  'edit.devCodeNote': 'Пошта-жіберуші бапталмаған. Тексеру коды:',
  'edit.invalidEmail': 'Дұрыс email енгізіңіз',

  // Team / access (RBAC)
  'profile.myId': 'СІЗДІҢ ID',
  'profile.idHint': 'Кіру құқығын алу үшін бұл ID-ды иесіне беріңіз',
  'profile.copied': 'ID көшірілді',
  'profile.team': 'Команда және рұқсаттар',
  'profile.invitations': 'Шақырулар',
  'invite.from': 'Шақырушы',
  'invite.accept': 'Қабылдау',
  'invite.decline': 'Бас тарту',
  'invite.wholeProfile': 'бүкіл профиль',
  'invite.selectedFields': 'таңдалған алқаптар',
  'role.owner': 'Иесі',
  'role.member': 'Қатысушы',
  'team.title': 'Команда',
  'team.subtitle': 'Профиль мен алқаптарға рұқсат беріңіз',
  'team.chooseProfile': 'ПРОФИЛЬ',
  'team.invite': 'ID БОЙЫНША ШАҚЫРУ',
  'team.idPlaceholder': 'Қатысушы ID, мыс. TA-AB3D9K',
  'team.permissions': 'НЕ РҰҚСАТ ЕТУ',
  'team.perm.view': 'Қарау және аналитика',
  'team.perm.ai': 'AI-құралдар',
  'team.perm.edit': 'Алқап қосу және өңдеу',
  'team.perm.inspect': 'Тексеру, агропаспорт, экспорт',
  'team.scope': 'АЛҚАПТАРҒА РҰҚСАТ',
  'team.scope.all': 'Профильдің барлық алқабы',
  'team.scope.selected': 'Таңдалған алқаптар',
  'team.send': 'Шақыру жіберу',
  'team.sent': 'Шақыру жіберілді',
  'team.members': 'ҚАТЫСУШЫЛАР МЕН ШАҚЫРУЛАР',
  'team.empty': 'Әзірге ешкім жоқ. Жоғарыдан ID арқылы шақырыңыз.',
  'team.statusPending': 'қабылдауды күтуде',
  'team.statusActive': 'белсенді',
  'team.revoke': 'Алып тастау',
  'team.leave': 'Профильден шығу',
  'team.onlyOwner': 'Тек профиль иесі қатысушыларды шақыра алады',
  'team.notFound': 'Мұндай ID бар пайдаланушы табылмады',
  'team.selectFields': 'Алқаптарды белгілеңіз',
  'team.error': 'Сәтсіз аяқталды. Деректерді тексеріңіз.',
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
