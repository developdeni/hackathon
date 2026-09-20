import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { readAsStringAsync } from 'expo-file-system/legacy';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { SymbolView, type SFSymbol } from 'expo-symbols';

import { Text } from '../src/components/AppText';
import { Avatar } from '../src/components/Avatar';
import { Badge } from '../src/components/Badge';
import { Card } from '../src/components/Card';
import { EmptyState } from '../src/components/EmptyState';
import { useAuth } from '../src/contexts/AuthContext';
import {
  deleteField,
  getServerHealth,
  listFieldsForProfile,
  listProfiles,
  syncOfflineQueue,
  CACHE_KEYS,
  diagnoseCropPhoto,
  countSeedlingsPhoto,
  countSeedlingsVideoFrames,
  analyzeGrainQuality,
  countLivestock,
  askAiAgronomist,
  loadAiChatHistory,
  saveAiChatHistory,
  clearAiChatHistory,
  getAiFarmSummary,
  cleanAiText,
} from '../src/services/api';
import { getLocalCache, getMemoryCache } from '../src/services/offline';
import { colors } from '../src/theme/colors';
import { fontFamilies } from '../src/theme/typography';
import { FarmProfile, Field, AiDiagnosisResult, AiStandCountResult, AiGrainQualityResult, AiLivestockResult, AiChatMessage, AiFarmSummary, AiFieldBadge } from '../src/types/domain';

type TabKey = 'ai_tools' | 'fields' | 'profile';

export interface FarmContextData {
  farmName: string;
  region: string;
  totalAreaHa: number;
  fieldsCount: number;
  inspectionCount: number;
  cropsSummary: string;
  coordinates?: {
    latitude: number;
    longitude: number;
  };
  fields: Array<{
    id: string;
    name: string;
    cropType: string;
    areaHa: number;
    inspectionCount?: number;
    badge?: string;
    coordinates?: {
      latitude: number;
      longitude: number;
    };
  }>;
  targetField?: {
    id: string;
    name: string;
    cropType: string;
    areaHa: number;
    perimeterKm?: number;
    inspectionCount?: number;
    badge?: string;
    coordinates?: {
      latitude: number;
      longitude: number;
    };
  };
  diagnosis?: any;
  weather?: any;
}



/* Typing dots animation component */
function TypingDots() {
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animate = (dot: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.3, duration: 300, useNativeDriver: true }),
        ])
      );
    const a1 = animate(dot1, 0);
    const a2 = animate(dot2, 200);
    const a3 = animate(dot3, 400);
    a1.start();
    a2.start();
    a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, [dot1, dot2, dot3]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 }}>
      {[dot1, dot2, dot3].map((dot, i) => (
        <Animated.View
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: 3.5,
            backgroundColor: colors.primaryDark,
            opacity: dot,
          }}
        />
      ))}
    </View>
  );
}

export default function MainScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, logout, refreshUser, isLoading: isAuthLoading } = useAuth();
  const params = useLocalSearchParams<{
    profileId?: string;
    tab?: TabKey;
    aiPrompt?: string;
    fieldId?: string;
  }>();

  // AI Tools opens by default as requested
  const [activeTab, setActiveTab] = useState<TabKey>(params.tab ?? 'ai_tools');
  // AI Tools sub-screens (chat/photo) go full-screen — hide the bottom nav there.
  const [aiImmersive, setAiImmersive] = useState(false);
  // Prompt forwarded from other tabs (e.g. farm summary quick questions)
  const [externalAiPrompt, setExternalAiPrompt] = useState<string | null>(null);
  const [selectedFieldForAi, setSelectedFieldForAi] = useState<Field | null>(null);

  // Instant hydration from fast memory cache (0ms perceived latency)
  const initialProfiles = getMemoryCache<FarmProfile[]>(CACHE_KEYS.PROFILES) ?? [];
  const initialProfileId =
    params.profileId ??
    initialProfiles.find((p) => p.fieldCount > 0)?.id ??
    initialProfiles[0]?.id ??
    null;
  const initialFields = initialProfileId
    ? getMemoryCache<Field[]>(CACHE_KEYS.FIELDS_PROFILE(initialProfileId)) ?? []
    : [];

  const [profiles, setProfiles] = useState<FarmProfile[]>(initialProfiles);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(initialProfileId);
  const [fields, setFields] = useState<Field[]>(initialFields);
  const [loading, setLoading] = useState(initialProfiles.length === 0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (params.profileId) {
      setSelectedProfileId(params.profileId);
      setActiveTab('fields');
    }
  }, [params.profileId]);

  useEffect(() => {
    if (params.tab) {
      setActiveTab(params.tab);
    }
    if (params.aiPrompt) {
      setExternalAiPrompt(params.aiPrompt);
      setActiveTab('ai_tools');
    }
    if (params.fieldId && fields.length > 0) {
      const found = fields.find((f) => f.id === params.fieldId);
      if (found) setSelectedFieldForAi(found);
    }
  }, [params.tab, params.aiPrompt, params.fieldId, fields]);


  const load = useCallback(async () => {
    // 1. If memory was empty on cold start, hydrate from disk immediately
    if (profiles.length === 0) {
      const cachedProfiles = await getLocalCache<FarmProfile[]>(CACHE_KEYS.PROFILES);
      if (cachedProfiles && cachedProfiles.length > 0) {
        setProfiles(cachedProfiles);
        const nextId =
          params.profileId ??
          selectedProfileId ??
          cachedProfiles.find((p) => p.fieldCount > 0)?.id ??
          cachedProfiles[0]?.id ??
          null;
        setSelectedProfileId(nextId);
        if (nextId) {
          const cachedFields = await getLocalCache<Field[]>(CACHE_KEYS.FIELDS_PROFILE(nextId));
          if (cachedFields) setFields(cachedFields);
        }
        setLoading(false);
      } else {
        setLoading(true);
      }
    }

    setError(null);
    try {
      // In the background, flush any pending inspections from offline outbox
      void syncOfflineQueue().catch(() => {});

      const [healthRes, profileItems] = await Promise.allSettled([
        getServerHealth(),
        listProfiles(),
      ]);

      const isOnline = healthRes.status === 'fulfilled' && healthRes.value.status === 'ok';
      setConnected(isOnline);

      if (profileItems.status === 'fulfilled') {
        const pList = profileItems.value;
        const profileWithFields = pList.find((profile) => profile.fieldCount > 0);
        const nextProfileId =
          params.profileId ?? selectedProfileId ?? profileWithFields?.id ?? pList[0]?.id ?? null;
        const fieldItems = nextProfileId ? await listFieldsForProfile(nextProfileId) : [];
        setProfiles(pList);
        setSelectedProfileId(nextProfileId);
        setFields(fieldItems);
      }
    } catch (nextError) {
      setConnected(false);
      if (profiles.length === 0) {
        setError(nextError instanceof Error ? nextError.message : 'Не удалось подключиться к серверу');
      }
    } finally {
      setLoading(false);
    }
  }, [params.profileId, selectedProfileId, profiles.length]);

  useFocusEffect(
    useCallback(() => {
      void load();
      void refreshUser();
    }, [load, refreshUser])
  );

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0] ?? null,
    [profiles, selectedProfileId]
  );
  const totalArea = fields.reduce((sum, field) => sum + field.areaHa, 0);
  const inspectionCount = fields.reduce((sum, field) => sum + field.inspectionCount, 0);

  const farmContext = useMemo<FarmContextData | null>(() => {
    if (!selectedProfile && fields.length === 0) return null;
    const cropsMap: Record<string, { count: number; area: number }> = {};
    let totalLats = 0;
    let totalLons = 0;
    let coordPointsCount = 0;

    for (const f of fields) {
      const c = f.cropType || 'Яровая пшеница';
      if (!cropsMap[c]) cropsMap[c] = { count: 0, area: 0 };
      cropsMap[c].count++;
      cropsMap[c].area += f.areaHa;
    }
    const cropsSummary = Object.entries(cropsMap)
      .map(([crop, d]) => `${crop}: ${d.count} уч. (${d.area.toFixed(1)} га)`)
      .join(', ');

    const fieldsData = fields.map((f) => {
      let fieldCenter: { latitude: number; longitude: number } | undefined;
      if (f.boundary && f.boundary.length > 0) {
        let sumLat = 0;
        let sumLon = 0;
        for (const pt of f.boundary) {
          sumLat += pt.latitude;
          sumLon += pt.longitude;
        }
        fieldCenter = {
          latitude: Number((sumLat / f.boundary.length).toFixed(4)),
          longitude: Number((sumLon / f.boundary.length).toFixed(4)),
        };
        totalLats += sumLat;
        totalLons += sumLon;
        coordPointsCount += f.boundary.length;
      }
      return {
        id: f.id,
        name: f.name,
        cropType: f.cropType,
        areaHa: f.areaHa,
        inspectionCount: f.inspectionCount ?? 0,
        coordinates: fieldCenter,
      };
    });

    const farmCoords =
      coordPointsCount > 0
        ? {
            latitude: Number((totalLats / coordPointsCount).toFixed(4)),
            longitude: Number((totalLons / coordPointsCount).toFixed(4)),
          }
        : { latitude: 51.6500, longitude: 71.3000 };

    let targetFieldData: any = undefined;
    if (selectedFieldForAi) {
      let tfCenter: { latitude: number; longitude: number } | undefined;
      if (selectedFieldForAi.boundary && selectedFieldForAi.boundary.length > 0) {
        const sumLat = selectedFieldForAi.boundary.reduce((s, p) => s + p.latitude, 0);
        const sumLon = selectedFieldForAi.boundary.reduce((s, p) => s + p.longitude, 0);
        tfCenter = {
          latitude: Number((sumLat / selectedFieldForAi.boundary.length).toFixed(4)),
          longitude: Number((sumLon / selectedFieldForAi.boundary.length).toFixed(4)),
        };
      }
      targetFieldData = {
        id: selectedFieldForAi.id,
        name: selectedFieldForAi.name,
        cropType: selectedFieldForAi.cropType,
        areaHa: selectedFieldForAi.areaHa,
        perimeterKm: selectedFieldForAi.perimeterKm,
        inspectionCount: selectedFieldForAi.inspectionCount,
        coordinates: tfCenter,
      };
    }

    return {
      farmName: selectedProfile?.name || 'Хозяйство',
      region: 'Акмолинская область',
      coordinates: farmCoords,
      totalAreaHa: Number(totalArea.toFixed(1)),
      fieldsCount: fields.length,
      inspectionCount,
      cropsSummary,
      fields: fieldsData,
      targetField: targetFieldData,
    };
  }, [selectedProfile, fields, totalArea, inspectionCount, selectedFieldForAi]);

  const handleAskAi = useCallback(
    (question: string) => {
      setExternalAiPrompt(question.trim());
      setActiveTab('ai_tools');
    },
    []
  );

  const handleAskFieldQuestion = useCallback(
    (field: Field, question: string) => {
      setSelectedFieldForAi(field);
      setExternalAiPrompt(question.trim());
      setActiveTab('ai_tools');
    },
    []
  );

  const handleAskFieldAi = useCallback(
    (field: Field) => {
      Alert.alert(
        `AI-Агроном · Поле «${field.name}»`,
        `Культура: ${field.cropType || 'не указана'} (${field.areaHa.toFixed(1)} га)\nВыберите вопрос для индивидуального анализа:`,
        [
          {
            text: '🌾 Прогноз и агро-рекомендации',
            onPress: () => {
              handleAskFieldQuestion(
                field,
                `Какой фитосанитарный прогноз и рекомендации по культуре ${field.cropType || 'растения'} на поле «${field.name}» (${field.areaHa.toFixed(1)} га)?`
              );
            },
          },
          {
            text: '💧 Баланс влаги и риски погоды',
            onPress: () => {
              handleAskFieldQuestion(
                field,
                `Оценить водный баланс, испаряемость и риски погоды для поля «${field.name}» (${field.cropType || 'растения'}) на ближайшие 7 дней.`
              );
            },
          },
          {
            text: '🛡️ Схема защиты от вредителей/болезней',
            onPress: () => {
              handleAskFieldQuestion(
                field,
                `Какая схема защиты от вредителей, сорняков и болезней рекомендуется для поля «${field.name}» (${field.cropType}) в Акмолинской области?`
              );
            },
          },
          {
            text: '🔍 План фитосанитарного осмотра',
            onPress: () => {
              handleAskFieldQuestion(
                field,
                `Составь детальный план обследования и чек-лист для полевого осмотра участка «${field.name}» (${field.cropType}, ${field.areaHa.toFixed(1)} га).`
              );
            },
          },
          { text: 'Отмена', style: 'cancel' },
        ]
      );
    },
    [handleAskFieldQuestion]
  );

  async function chooseProfile(profileId: string) {
    setSelectedProfileId(profileId);
    const cached = getMemoryCache<Field[]>(CACHE_KEYS.FIELDS_PROFILE(profileId));
    if (cached) {
      setFields(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      setFields(await listFieldsForProfile(profileId));
    } catch (nextError) {
      if (!cached) {
        setError(nextError instanceof Error ? nextError.message : 'Не удалось загрузить участки профиля');
      }
    } finally {
      setLoading(false);
    }
  }

  function confirmDelete(field: Field) {
    Alert.alert(
      'Удалить участок?',
      `Участок «${field.name}» и его осмотры будут удалены.`,
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: () => {
            void removeField(field.id);
          },
        },
      ]
    );
  }

  async function removeField(fieldId: string) {
    try {
      await deleteField(fieldId);
      setFields((current) => current.filter((field) => field.id !== fieldId));
    } catch (nextError) {
      Alert.alert('Не удалось удалить', nextError instanceof Error ? nextError.message : 'Повторите попытку.');
    }
  }

  return (
    <SafeAreaView style={styles.safeContainer} edges={['top']}>
      {/* Tab content */}
      <View style={styles.tabContentArea}>
        {/* AI Tools stays mounted (hidden, not unmounted) so an in-flight request
            and the chat state survive switching to another tab and back. */}
        <View
          style={[styles.tabPane, activeTab !== 'ai_tools' && styles.tabPaneHidden]}
          pointerEvents={activeTab === 'ai_tools' ? 'auto' : 'none'}
        >
          <AiToolsView
            onNavigateToFields={() => setActiveTab('fields')}
            onImmersiveChange={setAiImmersive}
            externalPrompt={externalAiPrompt}
            onClearExternalPrompt={() => setExternalAiPrompt(null)}
            farmContext={farmContext}
            targetField={selectedFieldForAi}
            onClearTargetField={() => setSelectedFieldForAi(null)}
          />
        </View>

        {activeTab === 'fields' && (
          <FieldsView
            profiles={profiles}
            selectedProfile={selectedProfile}
            fields={fields}
            loading={loading}
            connected={connected}
            error={error}
            totalArea={totalArea}
            inspectionCount={inspectionCount}
            onChooseProfile={chooseProfile}
            onRefresh={load}
            onDeleteField={confirmDelete}
            onNewProfile={() => router.push('/profile/new')}
            onNewField={() => {
              if (selectedProfile) {
                router.push({ pathname: '/field/new', params: { profileId: selectedProfile.id } });
              }
            }}
            onOpenField={(fieldId) => router.push({ pathname: '/field/[id]', params: { id: fieldId } })}
            onAskAi={handleAskAi}
            onAskFieldAi={handleAskFieldAi}
          />
        )}

        {activeTab === 'profile' && (
          <ProfileView
            user={user}
            isLoading={isAuthLoading}
            onLogout={logout}
            onNewProfile={() => router.push('/profile/new')}
          />
        )}
      </View>

      {/* STANDARD NATIVE IOS BOTTOM NAVIGATION BAR — hidden inside AI sub-screens */}
      {!(activeTab === 'ai_tools' && aiImmersive) && (
      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <Pressable
          onPress={() => setActiveTab('ai_tools')}
          style={({ pressed }) => [styles.tabItem, pressed && styles.pressed]}
        >
          <AppIcon
            name="cpu"
            size={22}
            color={activeTab === 'ai_tools' ? colors.primaryDark : '#8E8E93'}
          />
          <Text
            style={[
              styles.tabLabel,
              activeTab === 'ai_tools' && styles.tabLabelActive,
            ]}
          >
            AI Tools
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setActiveTab('fields')}
          style={({ pressed }) => [styles.tabItem, pressed && styles.pressed]}
        >
          <AppIcon
            name="square.grid.2x2"
            size={22}
            color={activeTab === 'fields' ? colors.primaryDark : '#8E8E93'}
          />
          <Text
            style={[
              styles.tabLabel,
              activeTab === 'fields' && styles.tabLabelActive,
            ]}
          >
            Участки
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setActiveTab('profile')}
          style={({ pressed }) => [styles.tabItem, pressed && styles.pressed]}
        >
          <AppIcon
            name="person.crop.circle"
            size={22}
            color={activeTab === 'profile' ? colors.primaryDark : '#8E8E93'}
          />
          <Text
            style={[
              styles.tabLabel,
              activeTab === 'profile' && styles.tabLabelActive,
            ]}
          >
            Профиль
          </Text>
        </Pressable>
      </View>
      )}
    </SafeAreaView>
  );
}

/* =========================================================================
   1. AI TOOLS VIEW (Gemini Vision Diagnosis + Agronomic Advisor Chat)
   ========================================================================= */

type AiViewMode = 'menu' | 'photo' | 'count' | 'grain' | 'livestock' | 'chat';

function speciesEmoji(nameEn?: string): string {
  switch (nameEn) {
    case 'cattle': return '🐄';
    case 'sheep': return '🐑';
    case 'goat': return '🐐';
    case 'horse': return '🐎';
    case 'pig': return '🐖';
    case 'camel': return '🐪';
    case 'poultry': return '🐔';
    case 'buffalo': return '🐃';
    default: return '🐾';
  }
}

// Метаданные категории диагностики: подпись, эмодзи, цвет и подпись строки СЗР.
function getDiagCategoryMeta(category?: string): {
  label: string;
  emoji: string;
  color: string;
  bg: string;
  chemLabel: string;
} {
  switch (category) {
    case 'pest':
      return { label: 'Вредитель', emoji: '🐛', color: '#B45309', bg: '#FEF3C7', chemLabel: '🐛 Инсектицид:' };
    case 'weed':
      return { label: 'Сорняк', emoji: '🌿', color: '#3F6212', bg: '#ECFCCB', chemLabel: '🌿 Гербицид:' };
    case 'healthy':
      return { label: 'Здоровое растение', emoji: '✅', color: '#166534', bg: '#DCFCE7', chemLabel: '💊 Профилактика:' };
    case 'none':
      return { label: 'Не распознано', emoji: '❓', color: '#6B7280', bg: '#F3F4F6', chemLabel: '💊 Препараты:' };
    default:
      return { label: 'Болезнь', emoji: '🦠', color: '#9D174D', bg: '#FCE7F3', chemLabel: '💊 Фунгицид:' };
  }
}

// iOS AVAssetImageGenerator может зависнуть на некоторых видео (не резолвит и не реджектит).
// Оборачиваем извлечение кадра в гонку с таймаутом, чтобы UI НИКОГДА не завис навсегда.
async function extractVideoFrame(uri: string, timeMs: number, timeoutMs = 7000): Promise<string | null> {
  try {
    const thumb = await Promise.race([
      VideoThumbnails.getThumbnailAsync(uri, { time: timeMs, quality: 0.6 }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!thumb || !('uri' in thumb)) return null;
    return await readAsStringAsync(thumb.uri, { encoding: 'base64' });
  } catch {
    return null;
  }
}

function getStandRatingMeta(rating?: string): {
  label: string;
  emoji: string;
  color: string;
  bg: string;
} {
  switch (rating) {
    case 'sparse':
      return { label: 'Ниже ориентира', emoji: '🔻', color: '#B45309', bg: '#FEF3C7' };
    case 'dense':
      return { label: 'Выше ориентира', emoji: '🔺', color: '#9D174D', bg: '#FCE7F3' };
    case 'optimal':
      return { label: 'В ориентире', emoji: '✅', color: '#166534', bg: '#DCFCE7' };
    default:
      return { label: 'Не определено', emoji: '❓', color: '#6B7280', bg: '#F3F4F6' };
  }
}

function getGrainRatingMeta(rating?: string): {
  label: string;
  emoji: string;
  color: string;
  bg: string;
} {
  switch (rating) {
    case 'good':
      return { label: 'Визуально чистая', emoji: '✅', color: '#166534', bg: '#DCFCE7' };
    case 'acceptable':
      return { label: 'Видимая примесь', emoji: '⚠️', color: '#B45309', bg: '#FEF3C7' };
    case 'poor':
      return { label: 'Высокая засорённость', emoji: '⛔', color: '#9D174D', bg: '#FCE7F3' };
    default:
      return { label: 'Не определено', emoji: '❓', color: '#6B7280', bg: '#F3F4F6' };
  }
}

function AiToolsView({
  onNavigateToFields,
  onImmersiveChange,
  externalPrompt,
  onClearExternalPrompt,
  farmContext,
  targetField,
  onClearTargetField,
}: {
  onNavigateToFields: () => void;
  onImmersiveChange: (immersive: boolean) => void;
  externalPrompt?: string | null;
  onClearExternalPrompt?: () => void;
  farmContext?: FarmContextData | null;
  targetField?: Field | null;
  onClearTargetField?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [viewMode, setViewMode] = useState<AiViewMode>('menu');

  // Chat/photo are full-screen sub-screens — tell the parent to hide the bottom nav.
  useEffect(() => {
    onImmersiveChange(viewMode !== 'menu');
  }, [viewMode, onImmersiveChange]);

  // Photo diagnosis state
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<AiDiagnosisResult | null>(null);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);

  // Задача 3.2 — подсчёт всходов / густота стояния
  const [countPhotoUri, setCountPhotoUri] = useState<string | null>(null);
  const [countIsVideo, setCountIsVideo] = useState(false);
  const [isCounting, setIsCounting] = useState(false);
  const [standResult, setStandResult] = useState<AiStandCountResult | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [standAreaText, setStandAreaText] = useState('');

  // Задача 3.3 — контроль качества зерна по фото пробы
  const [grainPhotoUri, setGrainPhotoUri] = useState<string | null>(null);
  const [isGrainAnalyzing, setIsGrainAnalyzing] = useState(false);
  const [grainResult, setGrainResult] = useState<AiGrainQualityResult | null>(null);
  const [grainError, setGrainError] = useState<string | null>(null);

  // Задача 3.4 — подсчёт поголовья скота
  const [herdPhotoUri, setHerdPhotoUri] = useState<string | null>(null);
  const [isHerdAnalyzing, setIsHerdAnalyzing] = useState(false);
  const [herdResult, setHerdResult] = useState<AiLivestockResult | null>(null);
  const [herdError, setHerdError] = useState<string | null>(null);
  const countRequestId = useRef(0);

  // Agronomic chat state
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isAnswering, setIsAnswering] = useState(false);
  const chatListRef = useRef<FlatList<AiChatMessage>>(null);
  const inputRef = useRef<TextInput>(null);

  // Track keyboard height directly — deterministic lift of the input above the keyboard
  // (more reliable than KeyboardAvoidingView with a nested layout + hidden tab bar).
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Load saved chat on mount
  useEffect(() => {
    void (async () => {
      const saved = await loadAiChatHistory();
      if (saved && saved.length > 0) {
        setMessages(saved);
      } else {
        setMessages([
          {
            id: 'welcome',
            sender: 'ai',
            text: 'Здравствуйте! Я — AI-агроном Tanap AI 🌾\n\nСфотографируйте лист, вредителя или сорняк — распознаю болезни, вредителей и сорняки и дам рекомендации по обработке. Или задайте вопрос по агрономии Акмолинской области.',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
      }
    })();
  }, []);

  // Auto-scroll when messages change or the keyboard opens (keeps latest reply visible).
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        chatListRef.current?.scrollToEnd({ animated: true });
      }, 150);
    }
  }, [messages.length, isAnswering, kbHeight]);

  const handlePickPhoto = async (fromCamera: boolean) => {
    try {
      setDiagnosisError(null);
      const permission = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        Alert.alert(
          'Доступ ограничен',
          fromCamera
            ? 'Для фотофиксации требуется доступ к камере устройства.'
            : 'Для выбора снимка требуется доступ к галерее.'
        );
        return;
      }

      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: ['images'],
        allowsEditing: true,
        quality: 0.7,
        base64: true,
      };

      const result = fromCamera
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      setPhotoUri(asset.uri);
      setViewMode('photo');

      if (!asset.base64) {
        setDiagnosisError('Не удалось прочитать данные фотографии.');
        return;
      }

      setIsDiagnosing(true);
      setDiagnosis(null);

      try {
        const diagResult = await diagnoseCropPhoto(asset.base64, asset.fileName || 'crop_leaf.jpg');
        setDiagnosis(diagResult);
      } catch (err: any) {
        setDiagnosisError(err?.message || 'Не удалось выполнить диагностику снимка');
      } finally {
        setIsDiagnosing(false);
      }
    } catch (err: any) {
      setDiagnosisError(err?.message || 'Ошибка выбора снимка');
    }
  };

  const handleAttachPress = () => {
    Alert.alert('Фото для диагностики', 'Снимок листа, вредителя или сорняка:', [
      { text: 'Сделать фото', onPress: () => void handlePickPhoto(true) },
      { text: 'Выбрать из галереи', onPress: () => void handlePickPhoto(false) },
      { text: 'Отмена', style: 'cancel' },
    ]);
  };

  const handleClearPhoto = () => {
    setPhotoUri(null);
    setDiagnosis(null);
    setDiagnosisError(null);
    setViewMode('menu');
  };

  const handlePickCountPhoto = async (fromCamera: boolean) => {
    try {
      setCountError(null);
      const normalizedArea = standAreaText.trim().replace(',', '.');
      const calibratedArea = normalizedArea ? Number(normalizedArea) : undefined;
      if (calibratedArea !== undefined && (!Number.isFinite(calibratedArea) || calibratedArea < 0.01 || calibratedArea > 10_000)) {
        Alert.alert('Проверьте площадь', 'Введите площадь кадра от 0,01 до 10 000 м² или оставьте поле пустым.');
        return;
      }
      const permission = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        Alert.alert(
          'Доступ ограничен',
          fromCamera
            ? 'Для съёмки требуется доступ к камере устройства.'
            : 'Для выбора снимка требуется доступ к галерее.'
        );
        return;
      }

      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: ['images', 'videos'],
        allowsEditing: false,
        quality: 0.8,
        base64: true,
        videoMaxDuration: 20,
      };

      const result = fromCamera
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      const isVideo = asset.type === 'video' || (asset.duration != null && asset.duration > 0);
      setCountPhotoUri(asset.uri);
      setCountIsVideo(isVideo);
      setViewMode('count');

      setIsCounting(true);
      setStandResult(null);
      const requestId = ++countRequestId.current;

      try {
        if (isVideo) {
          // Быстрый путь: извлекаем 3 кадра на телефоне и шлём только их (в разы легче, чем весь ролик).
          // asset.duration в миллисекундах; каждый кадр — с защитой от зависания AVAssetImageGenerator.
          const durationMs = Math.max(asset.duration ?? 10_000, 1_000);
          const times = [...new Set(
            [0.2, 0.5, 0.8].map((r) => Math.min(Math.round(durationMs * r), Math.max(durationMs - 300, 0)))
          )];
          const frames: string[] = [];
          for (const t of times) {
            if (requestId !== countRequestId.current) return;
            const frame = await extractVideoFrame(asset.uri, t);
            if (frame) frames.push(frame);
          }
          if (frames.length === 0) {
            if (requestId === countRequestId.current) {
              setCountError('Не удалось извлечь кадры из видео. Попробуйте другой ролик (mp4) или снимите фото.');
            }
            return;
          }
          const res = await countSeedlingsVideoFrames(frames, asset.fileName || 'field_stand.mp4');
          if (requestId === countRequestId.current) setStandResult(res);
        } else {
          if (!asset.base64) {
            setCountError('Не удалось прочитать данные фотографии.');
            return;
          }
          const res = await countSeedlingsPhoto(
            asset.base64,
            asset.fileName || 'field_stand.jpg',
            calibratedArea
          );
          if (requestId === countRequestId.current) setStandResult(res);
        }
      } catch (err: any) {
        if (requestId === countRequestId.current) {
          setCountError(err?.message || 'Не удалось выполнить подсчёт всходов');
        }
      } finally {
        if (requestId === countRequestId.current) setIsCounting(false);
      }
    } catch (err: any) {
      setCountError(err?.message || 'Ошибка выбора материала');
      setIsCounting(false);
    }
  };

  const handleClearCount = () => {
    countRequestId.current += 1;
    setIsCounting(false);
    setCountPhotoUri(null);
    setCountIsVideo(false);
    setStandResult(null);
    setCountError(null);
    setStandAreaText('');
    setViewMode('menu');
  };

  const handlePickGrainPhoto = async (fromCamera: boolean) => {
    try {
      setGrainError(null);
      const permission = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        Alert.alert(
          'Доступ ограничен',
          fromCamera
            ? 'Для съёмки требуется доступ к камере устройства.'
            : 'Для выбора снимка требуется доступ к галерее.'
        );
        return;
      }

      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.85,
        base64: true,
      };

      const result = fromCamera
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      setGrainPhotoUri(asset.uri);
      setViewMode('grain');

      if (!asset.base64) {
        setGrainError('Не удалось прочитать данные фотографии.');
        return;
      }

      setIsGrainAnalyzing(true);
      setGrainResult(null);

      try {
        const res = await analyzeGrainQuality(asset.base64, asset.fileName || 'grain_sample.jpg');
        setGrainResult(res);
      } catch (err: any) {
        setGrainError(err?.message || 'Не удалось выполнить анализ зерна');
      } finally {
        setIsGrainAnalyzing(false);
      }
    } catch (err: any) {
      setGrainError(err?.message || 'Ошибка выбора снимка');
    }
  };

  const handleClearGrain = () => {
    setGrainPhotoUri(null);
    setGrainResult(null);
    setGrainError(null);
    setViewMode('menu');
  };

  const handlePickHerdPhoto = async (fromCamera: boolean) => {
    try {
      setHerdError(null);
      const permission = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        Alert.alert(
          'Доступ ограничен',
          fromCamera
            ? 'Для съёмки требуется доступ к камере устройства.'
            : 'Для выбора снимка требуется доступ к галерее.'
        );
        return;
      }

      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.9, // выше качество — точнее подсчёт далёких/мелких животных
        base64: true,
      };

      const result = fromCamera
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      setHerdPhotoUri(asset.uri);
      setViewMode('livestock');

      if (!asset.base64) {
        setHerdError('Не удалось прочитать данные фотографии.');
        return;
      }

      setIsHerdAnalyzing(true);
      setHerdResult(null);

      try {
        const res = await countLivestock(asset.base64, asset.fileName || 'herd.jpg');
        setHerdResult(res);
      } catch (err: any) {
        setHerdError(err?.message || 'Не удалось выполнить подсчёт поголовья');
      } finally {
        setIsHerdAnalyzing(false);
      }
    } catch (err: any) {
      setHerdError(err?.message || 'Ошибка выбора снимка');
    }
  };

  const handleClearHerd = () => {
    setHerdPhotoUri(null);
    setHerdResult(null);
    setHerdError(null);
    setViewMode('menu');
  };

  const handleAskAboutDiagnosis = () => {
    if (!diagnosis) return;
    const kind =
      diagnosis.category === 'pest'
        ? 'схема инсектицидной защиты'
        : diagnosis.category === 'weed'
        ? 'схема гербицидной обработки'
        : 'схема фунгицидной защиты';
    const object = diagnosis.object_name || diagnosis.diagnosis;

    // Clean, natural user question for the chat bubble (SMS)
    const cleanUserQuestion = `Какая ${kind} рекомендуется для культуры «${diagnosis.crop}» (${object}) в Акмолинской области и что проверить в поле перед обработкой?`;

    // Hidden diagnosis context sent under the hood
    const diagnosisContext = {
      crop: diagnosis.crop,
      object_name: object,
      pathogen: diagnosis.pathogen,
      category: diagnosis.category,
      severity: diagnosis.severity,
      affected_area_percent: diagnosis.affected_area_percent,
      chemicals: diagnosis.chemicals,
      rate: diagnosis.rate,
      weather_limits: diagnosis.weather_limits,
    };

    setViewMode('chat');
    handleSendMessage(cleanUserQuestion, diagnosisContext);
  };

  const handleSendMessage = async (textToSend?: string, extraContext?: any) => {
    const q = (textToSend ?? inputText).trim();
    if (!q || isAnswering) return;

    Keyboard.dismiss();
    setInputText('');
    const userMsg: AiChatMessage = {
      id: `user_${Date.now()}`,
      sender: 'user',
      text: q,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    void saveAiChatHistory(nextMessages);
    setIsAnswering(true);

    try {
      // Only send last 10 messages as context to reduce payload and latency
      const recentHistory = nextMessages.slice(-10);
      const combinedContext = {
        ...(farmContext || {}),
        ...(extraContext ? { diagnosis: extraContext } : {}),
      };
      const answer = await askAiAgronomist(q, recentHistory, combinedContext);
      const aiMsg: AiChatMessage = {
        id: `ai_${Date.now()}`,
        sender: 'ai',
        text: cleanAiText(answer),
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      const updatedMessages = [...nextMessages, aiMsg];
      setMessages(updatedMessages);
      void saveAiChatHistory(updatedMessages);
    } catch (err: any) {
      const errorMsg: AiChatMessage = {
        id: `err_${Date.now()}`,
        sender: 'ai',
        text: `⚠️ ${err?.message || 'Сервер недоступен'}.\nПроверьте Wi-Fi и попробуйте ещё раз.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      const updatedMessages = [...nextMessages, errorMsg];
      setMessages(updatedMessages);
      void saveAiChatHistory(updatedMessages);
    } finally {
      setIsAnswering(false);
    }
  };

  useEffect(() => {
    if (externalPrompt) {
      setViewMode('chat');
      const timer = setTimeout(() => {
        void handleSendMessage(externalPrompt);
        onClearExternalPrompt?.();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [externalPrompt, onClearExternalPrompt]);

  const handleClearHistory = () => {
    Alert.alert('Очистить историю', 'Удалить переписку с AI-агрономом?', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Очистить',
        style: 'destructive',
        onPress: () => {
          void clearAiChatHistory();
          setMessages([
            {
              id: 'welcome',
              sender: 'ai',
              text: 'Диалог очищен. Задайте новый вопрос или прикрепите фото для анализа.',
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            },
          ]);
        },
      },
    ]);
  };

  const quickQuestions = targetField
    ? [
        `🌾 Прогноз для «${targetField.name}»`,
        `💧 Баланс влаги и погода`,
        `🛡️ Защита ${targetField.cropType || 'культуры'}`,
        `🔍 План осмотра участка`,
      ]
    : [
        '🌾 Норма высева пшеницы',
        '🦠 Жёлтая ржавчина',
        '🌿 Гербициды No-Till',
        '🧪 Септориоз листьев',
        '🌽 Сроки сева Акмолинская',
      ];

  const handleQuickChipPress = (chipText: string) => {
    if (targetField) {
      if (chipText.includes('Прогноз')) {
        handleSendMessage(
          `Какой фитосанитарный прогноз и рекомендации по культуре ${targetField.cropType || 'растения'} на поле «${targetField.name}» (${targetField.areaHa.toFixed(1)} га)?`
        );
      } else if (chipText.includes('Баланс влаги')) {
        handleSendMessage(
          `Оценить водный баланс, испаряемость и риски погоды для поля «${targetField.name}» на ближайшие 7 дней.`
        );
      } else if (chipText.includes('Защита')) {
        handleSendMessage(
          `Какая схема защиты от вредителей, сорняков и болезней рекомендуется для поля «${targetField.name}» (${targetField.cropType}) в Акмолинской области?`
        );
      } else if (chipText.includes('осмотра')) {
        handleSendMessage(
          `Составь детальный план обследования и чек-лист для полевого осмотра участка «${targetField.name}» (${targetField.cropType}, ${targetField.areaHa.toFixed(1)} га).`
        );
      } else {
        handleSendMessage(chipText);
      }
    } else {
      handleSendMessage(chipText);
    }
  };


  // ── Chat Message Renderer ──
  const renderMessage = useCallback(({ item: msg }: { item: AiChatMessage }) => {
    const isUser = msg.sender === 'user';
    const isError = msg.id.startsWith('err_');
    return (
      <View
        style={[
          styles.aiMessageWrap,
          isUser ? styles.aiMessageWrapUser : styles.aiMessageWrapAi,
        ]}
      >
        {!isUser && (
          <View style={styles.aiAvatarSmall}>
            <Text style={{ fontSize: 14 }}>🌱</Text>
          </View>
        )}
        <View
          style={[
            styles.aiBubble,
            isUser ? styles.aiBubbleUser : styles.aiBubbleAi,
            isError && styles.aiBubbleError,
          ]}
        >
          <Text
            style={[
              styles.aiBubbleText,
              isUser ? styles.aiBubbleTextUser : styles.aiBubbleTextAi,
              isError && { color: '#B91C1C' },
            ]}
            selectable
          >
            {cleanAiText(msg.text)}
          </Text>
          <Text
            style={[
              styles.aiBubbleTime,
              isUser ? styles.aiBubbleTimeUser : styles.aiBubbleTimeAi,
            ]}
          >
            {msg.timestamp}
          </Text>
        </View>
      </View>
    );
  }, []);

  // ── Menu View (two entry points) ──
  if (viewMode === 'menu') {
    return (
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.aiMenuHeader}>
          <View style={styles.aiChatHeaderAvatar}>
            <Text style={{ fontSize: 24 }}>🌱</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.aiMenuTitle}>AI Tools</Text>
            <Text style={styles.aiMenuSubtitle}>Помощник агронома Tanap AI</Text>
          </View>
        </View>

        <Pressable
          onPress={() => setViewMode('photo')}
          style={({ pressed }) => [styles.aiMenuCard, pressed && styles.aiMenuCardPressed]}
        >
          <View style={[styles.aiMenuIcon, { backgroundColor: '#E8F5E9' }]}>
            <Text style={{ fontSize: 26 }}>🔬</Text>
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.aiMenuCardTitle}>Распознавание по фото</Text>
            <Text style={styles.aiMenuCardDesc}>
              Болезни, вредители и сорняки по фотографии. Загрузите снимок — пойдёт анализ.
            </Text>
          </View>
          <SymbolView name="chevron.right" size={16} tintColor={colors.muted} fallback={<Text>›</Text>} />
        </Pressable>

        <Pressable
          onPress={() => setViewMode('count')}
          style={({ pressed }) => [styles.aiMenuCard, pressed && styles.aiMenuCardPressed]}
        >
          <View style={[styles.aiMenuIcon, { backgroundColor: '#FFF3E0' }]}>
            <Text style={{ fontSize: 26 }}>🌾</Text>
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.aiMenuCardTitle}>Подсчёт всходов и густоты</Text>
            <Text style={styles.aiMenuCardDesc}>
              Визуальный подсчёт всходов; плотность на м² только с измеренной площадью кадра.
            </Text>
          </View>
          <SymbolView name="chevron.right" size={16} tintColor={colors.muted} fallback={<Text>›</Text>} />
        </Pressable>

        <Pressable
          onPress={() => setViewMode('grain')}
          style={({ pressed }) => [styles.aiMenuCard, pressed && styles.aiMenuCardPressed]}
        >
          <View style={[styles.aiMenuIcon, { backgroundColor: '#FEF9C3' }]}>
            <Text style={{ fontSize: 26 }}>🌰</Text>
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.aiMenuCardTitle}>Визуальный разбор зерна</Text>
            <Text style={styles.aiMenuCardDesc}>
              Предварительная оценка видимых примесей и повреждений. Не заменяет лабораторию.
            </Text>
          </View>
          <SymbolView name="chevron.right" size={16} tintColor={colors.muted} fallback={<Text>›</Text>} />
        </Pressable>

        <Pressable
          onPress={() => setViewMode('livestock')}
          style={({ pressed }) => [styles.aiMenuCard, pressed && styles.aiMenuCardPressed]}
        >
          <View style={[styles.aiMenuIcon, { backgroundColor: '#EDE9FE' }]}>
            <Text style={{ fontSize: 26 }}>🐄</Text>
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.aiMenuCardTitle}>Подсчёт поголовья скота</Text>
            <Text style={styles.aiMenuCardDesc}>
              Предварительная оценка числа видимых животных по фото стада или кадру с дрона.
            </Text>
          </View>
          <SymbolView name="chevron.right" size={16} tintColor={colors.muted} fallback={<Text>›</Text>} />
        </Pressable>

        <Pressable
          onPress={() => setViewMode('chat')}
          style={({ pressed }) => [styles.aiMenuCard, pressed && styles.aiMenuCardPressed]}
        >
          <View style={[styles.aiMenuIcon, { backgroundColor: '#E3F2FD' }]}>
            <Text style={{ fontSize: 26 }}>💬</Text>
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.aiMenuCardTitle}>AI Агроном</Text>
            <Text style={styles.aiMenuCardDesc}>
              Чат-консультант по агрономии Акмолинской области: болезни, СЗР, сроки, нормы.
            </Text>
          </View>
          <SymbolView name="chevron.right" size={16} tintColor={colors.muted} fallback={<Text>›</Text>} />
        </Pressable>
      </ScrollView>
    );
  }

  // ── Photo Diagnosis View ──
  if (viewMode === 'photo') {
    return (
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Back to menu */}
        <Pressable
          onPress={handleClearPhoto}
          style={({ pressed }) => [styles.aiBackBtn, pressed && styles.pressed]}
        >
          <SymbolView name="chevron.left" size={16} tintColor={colors.primaryDark} fallback={<Text>←</Text>} />
          <Text style={styles.aiBackBtnText}>Назад</Text>
        </Pressable>

        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>ОЦЕНКА ПО ФОТО</Text>
          <Text style={styles.sectionHint}>болезни · вредители · сорняки</Text>
        </View>

        {/* Upload prompt when no photo yet */}
        {!photoUri && !isDiagnosing && (
          <Card style={styles.aiUploadCard}>
            <Text style={{ fontSize: 40 }}>📷</Text>
            <Text style={styles.aiUploadTitle}>Загрузите фото для анализа</Text>
            <Text style={styles.aiUploadDesc}>
              Снимок листа, вредителя или сорняка крупным планом при дневном свете.
            </Text>
            <Pressable
              onPress={() => handlePickPhoto(true)}
              style={({ pressed }) => [styles.aiUploadBtn, pressed && styles.pressed]}
            >
              <SymbolView name="camera.fill" size={18} tintColor="#fff" fallback={<Text>📷</Text>} />
              <Text style={styles.aiUploadBtnText}>Сделать фото</Text>
            </Pressable>
            <Pressable
              onPress={() => handlePickPhoto(false)}
              style={({ pressed }) => [styles.aiUploadBtnAlt, pressed && styles.pressed]}
            >
              <SymbolView name="photo.fill" size={18} tintColor={colors.primaryDark} fallback={<Text>🖼️</Text>} />
              <Text style={styles.aiUploadBtnAltText}>Выбрать из галереи</Text>
            </Pressable>
          </Card>
        )}

        {(photoUri || isDiagnosing || diagnosis) && (
        <Card style={styles.aiPhotoCard}>
          {photoUri && (
            <View style={styles.aiPreviewContainer}>
              <Image source={{ uri: photoUri }} style={styles.aiPreviewImage} resizeMode="cover" />
            </View>
          )}

          {isDiagnosing && (
            <View style={styles.aiDiagnosingBox}>
              <ActivityIndicator size="small" color={colors.primaryDark} />
              <Text style={styles.aiDiagnosingText}>ИИ анализирует фитопатологию...</Text>
            </View>
          )}

          {diagnosisError && (
            <View style={styles.aiErrorNotice}>
              <Text style={styles.aiErrorText}>{diagnosisError}</Text>
            </View>
          )}

          {diagnosis && (() => {
            const cat = getDiagCategoryMeta(diagnosis.category);
            return (
            <View style={styles.aiDiagResultCard}>
              <View style={styles.aiDiagHeaderRow}>
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={[styles.aiDiagCatPill, { backgroundColor: cat.bg }]}>
                    <Text style={{ fontSize: 12 }}>{cat.emoji}</Text>
                    <Text style={[styles.aiDiagCatText, { color: cat.color }]}>{cat.label}</Text>
                  </View>
                  {diagnosis.crop && diagnosis.crop !== '—' ? (
                    <Text style={styles.aiDiagCrop}>{diagnosis.crop}</Text>
                  ) : null}
                  <Text style={styles.aiDiagTitle}>{diagnosis.object_name || diagnosis.diagnosis}</Text>
                </View>
                <Badge
                  label={
                    !diagnosis.detected
                      ? 'НЕ ОПРЕДЕЛЕНО'
                      : diagnosis.severity === 'high'
                      ? 'ВЫСОКИЙ РИСК'
                      : diagnosis.severity === 'moderate'
                      ? 'УМЕРЕННЫЙ'
                      : 'НОРМА'
                  }
                  variant={
                    !diagnosis.detected
                      ? 'neutral'
                      : diagnosis.severity === 'high'
                      ? 'danger'
                      : diagnosis.severity === 'moderate'
                      ? 'warning'
                      : 'success'
                  }
                />
              </View>

              <View style={styles.aiDiagMetricsRow}>
                <View style={styles.aiDiagMetricItem}>
                  <Text style={styles.aiDiagMetricLabel}>Вероятный вид / причина</Text>
                  <Text style={styles.aiDiagMetricVal} numberOfLines={1}>{diagnosis.pathogen}</Text>
                </View>
                <View style={styles.aiDiagMetricItem}>
                  <Text style={styles.aiDiagMetricLabel}>Доля признаков в кадре</Text>
                  <Text style={styles.aiDiagMetricVal}>
                    {diagnosis.affected_area_percent != null ? `≈ ${diagnosis.affected_area_percent}%` : '—'}
                  </Text>
                </View>
              </View>

              <Text style={styles.aiDiagDesc}>Результат — визуальная гипотеза модели по этому кадру, не лабораторный диагноз и не оценка всего поля.</Text>

              {diagnosis.description ? (
                <Text style={styles.aiDiagDesc}>{diagnosis.description}</Text>
              ) : null}

              {diagnosis.detected ? (
                <View style={styles.aiProtocolBox}>
                  <Text style={styles.aiProtocolHeading}>
                    {diagnosis.category === 'healthy' ? 'Рекомендации:' : 'Справочная гипотеза:'}
                  </Text>
                  <View style={styles.aiProtocolRow}>
                    <Text style={styles.aiProtocolLabel}>{cat.chemLabel}</Text>
                    <Text style={styles.aiProtocolVal}>{diagnosis.chemicals}</Text>
                  </View>
                  <View style={styles.aiProtocolRow}>
                    <Text style={styles.aiProtocolLabel}>⚖️ Норма:</Text>
                    <Text style={styles.aiProtocolVal}>{diagnosis.rate}</Text>
                  </View>
                  <View style={styles.aiProtocolRow}>
                    <Text style={styles.aiProtocolLabel}>🌤️ Окно:</Text>
                    <Text style={styles.aiProtocolVal}>{diagnosis.weather_limits}</Text>
                  </View>
                  <View style={styles.aiProtocolRow}>
                    <Text style={styles.aiProtocolLabel}>Потери:</Text>
                    <Text style={styles.aiProtocolVal}>{diagnosis.yield_loss}</Text>
                  </View>
                  <Text style={styles.aiDiagDesc}>Перед обработкой подтвердите диагноз осмотром поля и проверьте регламент зарегистрированного препарата.</Text>
                </View>
              ) : diagnosis.recommendation ? (
                <View style={styles.aiProtocolBox}>
                  <Text style={styles.aiProtocolHeading}>Совет агронома:</Text>
                  <Text style={styles.aiDiagDesc}>{diagnosis.recommendation}</Text>
                </View>
              ) : null}

              <Pressable
                style={({ pressed }) => [styles.aiAskDiagBtn, pressed && styles.pressed]}
                onPress={diagnosis.detected ? handleAskAboutDiagnosis : () => setViewMode('chat')}
              >
                <SymbolView name="bubble.left.and.bubble.right.fill" size={16} tintColor="#fff" fallback={<Text>💬</Text>} />
                <Text style={styles.aiAskDiagBtnTextAlt}>
                  {diagnosis.detected ? 'Спросить агронома о диагнозе' : 'Перейти в чат с агрономом'}
                </Text>
              </Pressable>
            </View>
            );
          })()}
        </Card>
        )}

        {(diagnosis || diagnosisError) && !isDiagnosing && (
          <Pressable
            onPress={handleAttachPress}
            style={({ pressed }) => [styles.aiUploadBtnAlt, pressed && styles.pressed]}
          >
            <SymbolView name="arrow.triangle.2.circlepath" size={16} tintColor={colors.primaryDark} fallback={<Text>↺</Text>} />
            <Text style={styles.aiUploadBtnAltText}>Другое фото</Text>
          </Pressable>
        )}
      </ScrollView>
    );
  }

  // ── Stand-count / seedling density View (задача 3.2) ──
  if (viewMode === 'count') {
    return (
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          onPress={handleClearCount}
          style={({ pressed }) => [styles.aiBackBtn, pressed && styles.pressed]}
        >
          <SymbolView name="chevron.left" size={16} tintColor={colors.primaryDark} fallback={<Text>←</Text>} />
          <Text style={styles.aiBackBtnText}>Назад</Text>
        </Pressable>

        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>ГУСТОТА СТОЯНИЯ</Text>
          <Text style={styles.sectionHint}>подсчёт всходов · фото / дрон</Text>
        </View>

        {!countPhotoUri && !isCounting && (
          <Card style={styles.aiUploadCard}>
            <Text style={{ fontSize: 40 }}>🌾</Text>
            <Text style={styles.aiUploadTitle}>Загрузите фото или видео посева</Text>
            <Text style={styles.aiUploadDesc}>
              Для реальной плотности снимите растения внутри измеренной рамки и укажите её площадь. Без масштаба приложение покажет только визуальный подсчёт в кадре.
            </Text>
            <View style={styles.aiCalibrationWrap}>
              <Text style={styles.aiCalibrationLabel}>Площадь кадра, м² (необязательно)</Text>
              <TextInput
                value={standAreaText}
                onChangeText={setStandAreaText}
                keyboardType="decimal-pad"
                placeholder="Например, 1.0"
                placeholderTextColor={colors.muted}
                style={styles.aiCalibrationInput}
              />
              <Text style={styles.aiCalibrationHint}>Для видео площадь не применяется: масштаб между кадрами может меняться.</Text>
            </View>
            <Pressable
              onPress={() => handlePickCountPhoto(true)}
              style={({ pressed }) => [styles.aiUploadBtn, pressed && styles.pressed]}
            >
              <SymbolView name="camera.fill" size={18} tintColor="#fff" fallback={<Text>📷</Text>} />
              <Text style={styles.aiUploadBtnText}>Снять фото / видео</Text>
            </Pressable>
            <Pressable
              onPress={() => handlePickCountPhoto(false)}
              style={({ pressed }) => [styles.aiUploadBtnAlt, pressed && styles.pressed]}
            >
              <SymbolView name="photo.fill" size={18} tintColor={colors.primaryDark} fallback={<Text>🖼️</Text>} />
              <Text style={styles.aiUploadBtnAltText}>Выбрать из галереи</Text>
            </Pressable>
          </Card>
        )}

        {(countPhotoUri || isCounting || standResult) && (
        <Card style={styles.aiPhotoCard}>
          {countPhotoUri && (
            <View style={styles.aiPreviewContainer}>
              {countIsVideo ? (
                // Image не рендерит видео — показываем аккуратную плашку вместо чёрного прямоугольника
                <View style={[styles.aiPreviewImage, styles.aiVideoPlaceholder]}>
                  <SymbolView name="video.fill" size={32} tintColor="#fff" fallback={<Text style={{ fontSize: 30 }}>🎬</Text>} />
                  <Text style={styles.aiVideoPlaceholderText}>Видео загружено</Text>
                </View>
              ) : (
                <Image source={{ uri: countPhotoUri }} style={styles.aiPreviewImage} resizeMode="cover" />
              )}
              {countIsVideo && (
                <View style={styles.aiVideoBadge}>
                  <SymbolView name="video.fill" size={13} tintColor="#fff" fallback={<Text style={{ color: '#fff', fontSize: 11 }}>🎬</Text>} />
                  <Text style={styles.aiVideoBadgeText}>Видео</Text>
                </View>
              )}
            </View>
          )}

          {isCounting && (
            <View style={styles.aiDiagnosingBox}>
              <ActivityIndicator size="small" color={colors.primaryDark} />
              <Text style={styles.aiDiagnosingText}>
                {countIsVideo
                  ? 'ИИ анализирует видео и считает всходы...'
                  : 'ИИ считает всходы и оценивает густоту...'}
              </Text>
            </View>
          )}

          {countError && (
            <View style={styles.aiErrorNotice}>
              <Text style={styles.aiErrorText}>{countError}</Text>
            </View>
          )}

          {standResult && (() => {
            const meta = getStandRatingMeta(standResult.stand_rating);
            const notField = !standResult.detected || !standResult.is_field;
            return (
            <View style={styles.aiDiagResultCard}>
              {notField ? (
                <View style={styles.aiProtocolBox}>
                  <Text style={styles.aiProtocolHeading}>Посев не распознан</Text>
                  <Text style={styles.aiDiagDesc}>{standResult.assessment}</Text>
                  <Text style={[styles.aiDiagDesc, { marginTop: 6 }]}>{standResult.recommendation}</Text>
                </View>
              ) : (
                <>
                  <View style={styles.aiDiagHeaderRow}>
                    <View style={{ flex: 1, gap: 4 }}>
                      <View style={[styles.aiDiagCatPill, { backgroundColor: meta.bg }]}>
                        <Text style={{ fontSize: 12 }}>{meta.emoji}</Text>
                        <Text style={[styles.aiDiagCatText, { color: meta.color }]}>{meta.label}</Text>
                      </View>
                      {standResult.crop && standResult.crop !== '—' ? (
                        <Text style={styles.aiDiagCrop}>{standResult.crop}</Text>
                      ) : null}
                      <Text style={styles.aiDiagTitle}>
                        {standResult.shot_type === 'drone' ? '🚁 Съёмка с дрона' : '📷 Наземное фото'}
                      </Text>
                    </View>
                    <Badge label="ОЦЕНКА ИИ" variant="neutral" />
                  </View>

                  <View style={styles.aiStandCountBox}>
                    <Text style={styles.aiStandCountNumber}>~{standResult.plant_count}</Text>
                    <Text style={styles.aiStandCountCaption}>различимых всходов в типичном кадре</Text>
                  </View>

                  <View style={styles.aiDiagMetricsRow}>
                    <View style={styles.aiDiagMetricItem}>
                      <Text style={styles.aiDiagMetricLabel}>Плотность</Text>
                      <Text style={styles.aiDiagMetricVal}>
                        {standResult.density_per_m2 != null ? `${standResult.density_per_m2}/м²` : 'нет масштаба'}
                      </Text>
                    </View>
                    <View style={styles.aiDiagMetricItem}>
                      <Text style={styles.aiDiagMetricLabel}>Ориентир*</Text>
                      <Text style={styles.aiDiagMetricVal} numberOfLines={1}>
                        {standResult.density_per_m2 != null ? standResult.optimal_range_m2 : '—'}
                      </Text>
                    </View>
                    <View style={styles.aiDiagMetricItem}>
                      <Text style={styles.aiDiagMetricLabel}>Равномерность</Text>
                      <Text style={styles.aiDiagMetricVal}>
                        {standResult.uniformity === 'high'
                          ? 'Высокая'
                          : standResult.uniformity === 'moderate'
                          ? 'Средняя'
                          : standResult.uniformity === 'low'
                          ? 'Низкая'
                          : '—'}
                      </Text>
                    </View>
                  </View>

                  {standResult.frame_area_m2 != null && standResult.density_per_ha != null ? (
                    <View style={styles.aiProtocolBox}>
                      <Text style={styles.aiProtocolHeading}>Расчёт по введённой площади:</Text>
                      <Text style={styles.aiDiagDesc}>
                        Кадр {standResult.frame_area_m2} м² · эквивалент {standResult.density_per_ha >= 1000
                          ? `${(standResult.density_per_ha / 1000).toFixed(0)} тыс./га`
                          : `${standResult.density_per_ha}/га`}
                      </Text>
                      <Text style={styles.aiDiagDesc}>* Справочный диапазон по вероятно распознанной культуре, не индивидуальная норма высева для поля.</Text>
                    </View>
                  ) : (
                    <View style={styles.aiProtocolBox}>
                      <Text style={styles.aiProtocolHeading}>Плотность не рассчитана</Text>
                      <Text style={styles.aiDiagDesc}>Нужна измеренная площадь кадра. Масштаб по одному фото приложение не угадывает.</Text>
                    </View>
                  )}

                  {standResult.assessment ? (
                    <Text style={styles.aiDiagDesc}>{standResult.assessment}</Text>
                  ) : null}

                  {standResult.recommendation && standResult.recommendation !== '—' ? (
                    <View style={styles.aiProtocolBox}>
                      <Text style={styles.aiProtocolHeading}>Рекомендация:</Text>
                      <Text style={styles.aiDiagDesc}>{standResult.recommendation}</Text>
                    </View>
                  ) : null}
                </>
              )}
            </View>
            );
          })()}
        </Card>
        )}

        {(standResult || countError) && !isCounting && (
          <Pressable
            onPress={() =>
              Alert.alert('Материал посева', 'Фото рядков, ортоснимок или видео облёта дроном:', [
                { text: 'Снять фото / видео', onPress: () => void handlePickCountPhoto(true) },
                { text: 'Выбрать из галереи', onPress: () => void handlePickCountPhoto(false) },
                { text: 'Отмена', style: 'cancel' },
              ])
            }
            style={({ pressed }) => [styles.aiUploadBtnAlt, pressed && styles.pressed]}
          >
            <SymbolView name="arrow.triangle.2.circlepath" size={16} tintColor={colors.primaryDark} fallback={<Text>↺</Text>} />
            <Text style={styles.aiUploadBtnAltText}>Другой материал</Text>
          </Pressable>
        )}
      </ScrollView>
    );
  }

  // ── Grain quality control View (задача 3.3) ──
  if (viewMode === 'grain') {
    return (
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          onPress={handleClearGrain}
          style={({ pressed }) => [styles.aiBackBtn, pressed && styles.pressed]}
        >
          <SymbolView name="chevron.left" size={16} tintColor={colors.primaryDark} fallback={<Text>←</Text>} />
          <Text style={styles.aiBackBtnText}>Назад</Text>
        </Pressable>

        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>РАЗБОР ЗЕРНА</Text>
          <Text style={styles.sectionHint}>примеси · битое · повреждённое</Text>
        </View>

        {!grainPhotoUri && !isGrainAnalyzing && (
          <Card style={styles.aiUploadCard}>
            <Text style={{ fontSize: 40 }}>🌰</Text>
            <Text style={styles.aiUploadTitle}>Сфотографируйте пробу зерна</Text>
            <Text style={styles.aiUploadDesc}>
              Рассыпьте зерно тонким слоем на ровной однотонной поверхности и снимите крупным планом при дневном свете.
            </Text>
            <Pressable
              onPress={() => handlePickGrainPhoto(true)}
              style={({ pressed }) => [styles.aiUploadBtn, pressed && styles.pressed]}
            >
              <SymbolView name="camera.fill" size={18} tintColor="#fff" fallback={<Text>📷</Text>} />
              <Text style={styles.aiUploadBtnText}>Сделать фото</Text>
            </Pressable>
            <Pressable
              onPress={() => handlePickGrainPhoto(false)}
              style={({ pressed }) => [styles.aiUploadBtnAlt, pressed && styles.pressed]}
            >
              <SymbolView name="photo.fill" size={18} tintColor={colors.primaryDark} fallback={<Text>🖼️</Text>} />
              <Text style={styles.aiUploadBtnAltText}>Выбрать из галереи</Text>
            </Pressable>
          </Card>
        )}

        {(grainPhotoUri || isGrainAnalyzing || grainResult) && (
        <Card style={styles.aiPhotoCard}>
          {grainPhotoUri && (
            <View style={styles.aiPreviewContainer}>
              <Image source={{ uri: grainPhotoUri }} style={styles.aiPreviewImage} resizeMode="cover" />
            </View>
          )}

          {isGrainAnalyzing && (
            <View style={styles.aiDiagnosingBox}>
              <ActivityIndicator size="small" color={colors.primaryDark} />
              <Text style={styles.aiDiagnosingText}>ИИ оценивает засорённость и повреждения...</Text>
            </View>
          )}

          {grainError && (
            <View style={styles.aiErrorNotice}>
              <Text style={styles.aiErrorText}>{grainError}</Text>
            </View>
          )}

          {grainResult && (() => {
            const meta = getGrainRatingMeta(grainResult.quality_rating);
            const notGrain = !grainResult.detected || !grainResult.is_grain;
            return (
            <View style={styles.aiDiagResultCard}>
              {notGrain ? (
                <View style={styles.aiProtocolBox}>
                  <Text style={styles.aiProtocolHeading}>Проба зерна не распознана</Text>
                  <Text style={styles.aiDiagDesc}>{grainResult.assessment}</Text>
                  <Text style={[styles.aiDiagDesc, { marginTop: 6 }]}>{grainResult.recommendation}</Text>
                </View>
              ) : (
                <>
                  <View style={styles.aiDiagHeaderRow}>
                    <View style={{ flex: 1, gap: 4 }}>
                      <View style={[styles.aiDiagCatPill, { backgroundColor: meta.bg }]}>
                        <Text style={{ fontSize: 12 }}>{meta.emoji}</Text>
                        <Text style={[styles.aiDiagCatText, { color: meta.color }]}>{meta.label}</Text>
                      </View>
                      {grainResult.crop && grainResult.crop !== '—' ? (
                        <Text style={styles.aiDiagCrop}>{grainResult.crop}</Text>
                      ) : null}
                      <Text style={styles.aiDiagTitle}>Предварительный разбор фото</Text>
                    </View>
                    <Badge label="ОЦЕНКА ИИ" variant="neutral" />
                  </View>

                  <View style={styles.aiStandCountBox}>
                    <Text style={styles.aiStandCountNumber}>
                      {grainResult.sound_percent != null ? `≈ ${grainResult.sound_percent}%` : '—'}
                    </Text>
                    <Text style={styles.aiStandCountCaption}>визуальная доля целых зёрен в кадре</Text>
                  </View>

                  {/* Показатели засорённости и повреждений */}
                  <View style={styles.aiGrainBars}>
                    {[
                      { label: 'Сорная примесь', val: grainResult.weed_impurity_percent, color: '#B45309' },
                      { label: 'Зерновая примесь', val: grainResult.grain_impurity_percent, color: '#CA8A04' },
                      { label: 'Битое зерно', val: grainResult.broken_percent, color: '#DC2626' },
                      { label: 'Повреждённое', val: grainResult.damaged_percent, color: '#9D174D' },
                    ].map((row) => (
                      <View key={row.label} style={styles.aiGrainRow}>
                        <Text style={styles.aiGrainRowLabel}>{row.label}</Text>
                        <View style={styles.aiGrainTrack}>
                          <View
                            style={[
                              styles.aiGrainFill,
                              { width: `${Math.min(row.val ?? 0, 100)}%`, backgroundColor: row.color },
                            ]}
                          />
                        </View>
                        <Text style={[styles.aiGrainRowVal, { color: row.color }]}>
                          {row.val != null ? `≈ ${row.val}%` : '—'}
                        </Text>
                      </View>
                    ))}
                  </View>

                  {grainResult.grain_count > 0 ? (
                    <Text style={styles.aiGrainCount}>Оценено зёрен в кадре: ~{grainResult.grain_count}</Text>
                  ) : null}

                  <View style={styles.aiProtocolBox}>
                    <Text style={styles.aiProtocolHeading}>Не лабораторный результат</Text>
                    <Text style={styles.aiDiagDesc}>Проценты рассчитаны по видимым объектам на фото, не по массе. Класс, влажность, белок и клейковина требуют отбора пробы и лаборатории.</Text>
                  </View>

                  {grainResult.assessment ? (
                    <Text style={styles.aiDiagDesc}>{grainResult.assessment}</Text>
                  ) : null}

                  {grainResult.recommendation && grainResult.recommendation !== '—' ? (
                    <View style={styles.aiProtocolBox}>
                      <Text style={styles.aiProtocolHeading}>Рекомендация:</Text>
                      <Text style={styles.aiDiagDesc}>{grainResult.recommendation}</Text>
                    </View>
                  ) : null}
                </>
              )}
            </View>
            );
          })()}
        </Card>
        )}

        {(grainResult || grainError) && !isGrainAnalyzing && (
          <Pressable
            onPress={() =>
              Alert.alert('Проба зерна', 'Фото пробы крупным планом:', [
                { text: 'Сделать фото', onPress: () => void handlePickGrainPhoto(true) },
                { text: 'Выбрать из галереи', onPress: () => void handlePickGrainPhoto(false) },
                { text: 'Отмена', style: 'cancel' },
              ])
            }
            style={({ pressed }) => [styles.aiUploadBtnAlt, pressed && styles.pressed]}
          >
            <SymbolView name="arrow.triangle.2.circlepath" size={16} tintColor={colors.primaryDark} fallback={<Text>↺</Text>} />
            <Text style={styles.aiUploadBtnAltText}>Другое фото</Text>
          </Pressable>
        )}
      </ScrollView>
    );
  }

  // ── Livestock counting View (задача 3.4) ──
  if (viewMode === 'livestock') {
    return (
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          onPress={handleClearHerd}
          style={({ pressed }) => [styles.aiBackBtn, pressed && styles.pressed]}
        >
          <SymbolView name="chevron.left" size={16} tintColor={colors.primaryDark} fallback={<Text>←</Text>} />
          <Text style={styles.aiBackBtnText}>Назад</Text>
        </Pressable>

        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>ПОДСЧЁТ ПОГОЛОВЬЯ</Text>
          <Text style={styles.sectionHint}>визуальная оценка по фото</Text>
        </View>

        {!herdPhotoUri && !isHerdAnalyzing && (
          <Card style={styles.aiUploadCard}>
            <Text style={{ fontSize: 40 }}>🐄</Text>
            <Text style={styles.aiUploadTitle}>Сфотографируйте стадо</Text>
            <Text style={styles.aiUploadDesc}>
              Снимите стадо целиком при хорошем освещении. Для точности плотного стада лучше кадр с дрона (вид сверху).
            </Text>
            <Pressable
              onPress={() => handlePickHerdPhoto(true)}
              style={({ pressed }) => [styles.aiUploadBtn, pressed && styles.pressed]}
            >
              <SymbolView name="camera.fill" size={18} tintColor="#fff" fallback={<Text>📷</Text>} />
              <Text style={styles.aiUploadBtnText}>Сделать фото</Text>
            </Pressable>
            <Pressable
              onPress={() => handlePickHerdPhoto(false)}
              style={({ pressed }) => [styles.aiUploadBtnAlt, pressed && styles.pressed]}
            >
              <SymbolView name="photo.fill" size={18} tintColor={colors.primaryDark} fallback={<Text>🖼️</Text>} />
              <Text style={styles.aiUploadBtnAltText}>Выбрать из галереи</Text>
            </Pressable>
          </Card>
        )}

        {(herdPhotoUri || isHerdAnalyzing || herdResult) && (
        <Card style={styles.aiPhotoCard}>
          {herdPhotoUri && (
            <View style={styles.aiPreviewContainer}>
              <Image source={{ uri: herdPhotoUri }} style={styles.aiPreviewImage} resizeMode="cover" />
            </View>
          )}

          {isHerdAnalyzing && (
            <View style={styles.aiDiagnosingBox}>
              <ActivityIndicator size="small" color={colors.primaryDark} />
              <Text style={styles.aiDiagnosingText}>ИИ считает животных по сетке (для точности)...</Text>
            </View>
          )}

          {herdError && (
            <View style={styles.aiErrorNotice}>
              <Text style={styles.aiErrorText}>{herdError}</Text>
            </View>
          )}

          {herdResult && (() => {
            const notHerd = !herdResult.detected || !herdResult.is_livestock;
            return (
            <View style={styles.aiDiagResultCard}>
              {notHerd ? (
                <View style={styles.aiProtocolBox}>
                  <Text style={styles.aiProtocolHeading}>Скот не обнаружен</Text>
                  <Text style={styles.aiDiagDesc}>{herdResult.assessment}</Text>
                  <Text style={[styles.aiDiagDesc, { marginTop: 6 }]}>{herdResult.recommendation}</Text>
                </View>
              ) : (
                <>
                  <View style={styles.aiDiagHeaderRow}>
                    <View style={{ flex: 1, gap: 4 }}>
                      <View style={[styles.aiDiagCatPill, { backgroundColor: '#EDE9FE' }]}>
                        <Text style={{ fontSize: 12 }}>{herdResult.shot_type === 'drone' ? '🚁' : '📷'}</Text>
                        <Text style={[styles.aiDiagCatText, { color: '#6D28D9' }]}>
                          {herdResult.shot_type === 'drone' ? 'Съёмка с дрона' : 'Наземное фото'}
                        </Text>
                      </View>
                      <Text style={styles.aiDiagTitle}>{herdResult.dominant_species}</Text>
                    </View>
                    <Badge label="ОЦЕНКА ИИ" variant="neutral" />
                  </View>

                  <View style={[styles.aiStandCountBox, { backgroundColor: '#F5F3FF' }]}>
                    <Text style={[styles.aiStandCountNumber, { color: '#6D28D9' }]}>~{herdResult.total_count}</Text>
                    <Text style={styles.aiStandCountCaption}>
                      видимых голов{herdResult.count_range && herdResult.count_range !== '—' ? ` · диапазон ${herdResult.count_range}` : ''}
                    </Text>
                  </View>

                  {/* Разбивка по видам */}
                  {herdResult.species.length > 0 && (
                    <View style={styles.aiSpeciesList}>
                      {herdResult.species.map((sp, idx) => (
                        <View key={`${sp.name_en}-${idx}`} style={styles.aiSpeciesRow}>
                          <Text style={styles.aiSpeciesEmoji}>{speciesEmoji(sp.name_en)}</Text>
                          <Text style={styles.aiSpeciesName} numberOfLines={1}>{sp.name}</Text>
                          <Text style={styles.aiSpeciesCount}>~{sp.count}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {herdResult.crowding && herdResult.crowding !== '—' ? (
                    <Text style={styles.aiGrainCount}>
                      Скученность: {herdResult.crowding === 'high' ? 'высокая' : herdResult.crowding === 'moderate' ? 'средняя' : 'низкая'}
                    </Text>
                  ) : null}

                  {herdResult.assessment ? (
                    <Text style={styles.aiDiagDesc}>{herdResult.assessment}</Text>
                  ) : null}

                  {herdResult.recommendation && herdResult.recommendation !== '—' ? (
                    <View style={styles.aiProtocolBox}>
                      <Text style={styles.aiProtocolHeading}>Совет для точности:</Text>
                      <Text style={styles.aiDiagDesc}>{herdResult.recommendation}</Text>
                    </View>
                  ) : null}
                </>
              )}
            </View>
            );
          })()}
        </Card>
        )}

        {(herdResult || herdError) && !isHerdAnalyzing && (
          <Pressable
            onPress={() =>
              Alert.alert('Фото стада', 'Снимок поголовья крупным планом:', [
                { text: 'Сделать фото', onPress: () => void handlePickHerdPhoto(true) },
                { text: 'Выбрать из галереи', onPress: () => void handlePickHerdPhoto(false) },
                { text: 'Отмена', style: 'cancel' },
              ])
            }
            style={({ pressed }) => [styles.aiUploadBtnAlt, pressed && styles.pressed]}
          >
            <SymbolView name="arrow.triangle.2.circlepath" size={16} tintColor={colors.primaryDark} fallback={<Text>↺</Text>} />
            <Text style={styles.aiUploadBtnAltText}>Другое фото</Text>
          </Pressable>
        )}
      </ScrollView>
    );
  }

  // ── Main Chat View (Full-screen messenger layout) ──
  const canSend = !!inputText.trim() && !isAnswering;
  return (
    <View style={styles.aiChatContainer}>
      {/* Header Bar */}
      <View style={styles.aiChatHeader}>
        <View style={styles.aiChatHeaderLeft}>
          <Pressable
            onPress={() => setViewMode('menu')}
            style={({ pressed }) => [styles.aiChatBackBtn, pressed && styles.pressed]}
            hitSlop={8}
          >
            <SymbolView name="chevron.left" size={20} tintColor={colors.primaryDark} fallback={<Text>←</Text>} />
          </Pressable>
          <View style={styles.aiChatHeaderAvatar}>
            <Text style={{ fontSize: 20 }}>🌱</Text>
          </View>
          <View style={styles.aiChatHeaderTextWrap}>
            <Text style={styles.aiChatHeaderTitle} numberOfLines={1}>AI Агроном</Text>
            <View style={styles.aiChatHeaderStatusRow}>
              <View style={styles.aiChatHeaderDot} />
              <Text style={styles.aiChatHeaderStatus} numberOfLines={1}>На связи</Text>
            </View>
          </View>
        </View>
        {messages.length > 1 && (
          <Pressable
            onPress={handleClearHistory}
            style={({ pressed }) => [styles.aiChatHeaderBtn, pressed && styles.pressed]}
            hitSlop={10}
          >
            <SymbolView name="trash" size={16} tintColor={colors.muted} fallback={<Text>🗑️</Text>} />
          </Pressable>
        )}
      </View>

      {/* Target field indicator banner */}
      {targetField && (
        <View style={styles.targetFieldBanner}>
          <View style={styles.targetFieldBannerLeft}>
            <Text style={{ fontSize: 13 }}>📍</Text>
            <Text style={styles.targetFieldBannerText} numberOfLines={1}>
              Вопрос по участку: <Text style={styles.targetFieldBannerBold}>«{targetField.name}»</Text> ({targetField.cropType || 'не указана'}, {targetField.areaHa.toFixed(1)} га)
            </Text>
          </View>
          {onClearTargetField && (
            <Pressable onPress={onClearTargetField} hitSlop={8} style={styles.targetFieldClearBtn}>
              <Text style={styles.targetFieldClearText}>Все поля ✕</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Quick Chips (only show when few messages) */}
      {messages.length <= 2 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.aiChipsScroll}
          style={styles.aiChipsRow}
        >
          {quickQuestions.map((q, idx) => (
            <Pressable
              key={idx}
              style={({ pressed }) => [styles.aiChip, pressed && styles.aiChipPressed]}
              onPress={() => handleQuickChipPress(q)}
              disabled={isAnswering}
            >
              <Text style={styles.aiChipText}>{q}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* Messages List */}
      <FlatList
        ref={chatListRef}
        style={styles.aiChatList}
        data={messages}
        renderItem={renderMessage}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.aiChatListContent}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListFooterComponent={
          isAnswering ? (
            <View style={[styles.aiMessageWrap, styles.aiMessageWrapAi]}>
              <View style={styles.aiAvatarSmall}>
                <Text style={{ fontSize: 14 }}>🌱</Text>
              </View>
              <View style={[styles.aiBubble, styles.aiBubbleAi]}>
                <TypingDots />
              </View>
            </View>
          ) : null
        }
        onContentSizeChange={() => {
          chatListRef.current?.scrollToEnd({ animated: true });
        }}
      />

      {/* Input Bar */}
      <View
        style={[
          styles.aiInputBarWrap,
          { paddingBottom: kbHeight > 0 ? kbHeight + 8 : Math.max(insets.bottom, 10) },
        ]}
      >
        <View style={styles.aiInputBar}>
          <TextInput
            ref={inputRef}
            style={styles.aiTextInput}
            placeholder="Спросите агронома…"
            placeholderTextColor={colors.muted}
            value={inputText}
            onChangeText={setInputText}
            multiline
            maxLength={500}
            editable={!isAnswering}
            onSubmitEditing={() => handleSendMessage()}
            blurOnSubmit={false}
          />
          <Pressable
            style={({ pressed }) => [
              styles.aiSendButton,
              !canSend && styles.aiSendButtonDisabled,
              pressed && canSend && styles.pressed,
            ]}
            onPress={() => handleSendMessage()}
            disabled={!canSend}
          >
            <SymbolView
              name="arrow.up"
              size={18}
              tintColor="#FFFFFF"
              fallback={<Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 16 }}>↑</Text>}
            />
          </Pressable>
        </View>
      </View>
    </View>
  );
}



/* =========================================================================
   2.1. AI FARM DIGEST CARD (AI-Сводка хозяйства)
   ========================================================================= */
interface AiFarmDigestCardProps {
  summary: AiFarmSummary | null;
  loading: boolean;
  onRefresh: () => void;
  onAskQuestion: (q: string) => void;
}

function AiFarmDigestCard({
  summary,
  loading,
  onRefresh,
  onAskQuestion,
}: AiFarmDigestCardProps) {
  if (!summary && !loading) return null;

  return (
    <Card style={styles.aiDigestCard}>
      {/* Top Header */}
      <View style={styles.aiDigestHeader}>
        <View style={styles.aiDigestHeaderLeft}>
          <View style={styles.aiDigestIconWrap}>
            <AppIcon name="sparkles" size={13} color="#1B5E20" />
          </View>
          <Text style={styles.aiDigestHeaderTitle}>AI-СВОДКА ХОЗЯЙСТВА</Text>
        </View>
        <Pressable
          onPress={onRefresh}
          disabled={loading}
          hitSlop={8}
          style={({ pressed }) => [styles.aiDigestRefreshBtn, pressed && styles.pressed]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <AppIcon name="arrow.clockwise" size={13} color={colors.textSecondary} />
          )}
        </Pressable>
      </View>

      {/* Main summary text & chips */}
      <View style={styles.aiDigestBody}>
        {loading && !summary ? (
          <View style={styles.aiDigestLoadingBox}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.aiDigestLoadingText}>Анализ хозяйства AI-агрономом…</Text>
          </View>
        ) : summary ? (
          <>
            <Text style={styles.aiDigestText}>{cleanAiText(summary.summaryText)}</Text>
            {summary.cropsSummary ? (
              <View style={styles.aiDigestMetaRow}>
                <AppIcon name="leaf" size={12} color="#2E7D32" />
                <Text style={styles.aiDigestMetaText} numberOfLines={1}>
                  Посевы: {summary.cropsSummary}
                </Text>
              </View>
            ) : null}

            {/* Quick questions chips */}
            {summary.quickQuestions && summary.quickQuestions.length > 0 ? (
              <View style={styles.aiDigestChipsSection}>
                <Text style={styles.aiDigestChipsTitle}>БЫСТРЫЕ ВОПРОСЫ К ИИ:</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.aiDigestChipsRow}
                >
                  {summary.quickQuestions.map((question, idx) => (
                    <Pressable
                      key={idx}
                      onPress={() => onAskQuestion(question)}
                      style={({ pressed }) => [
                        styles.aiDigestChip,
                        pressed && styles.aiDigestChipPressed,
                      ]}
                    >
                      <Text style={styles.aiDigestChipText}>{question}</Text>
                      <AppIcon name="arrow.up.right" size={10} color="#1B5E20" />
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}

            {/* Bottom action button */}
            <Pressable
              onPress={() =>
                onAskQuestion('Составь детальный план обследования полей и фитосанитарный прогноз для нашего хозяйства на ближайшую неделю.')
              }
              style={({ pressed }) => [
                styles.aiDigestChatButton,
                pressed && styles.aiDigestChatButtonPressed,
              ]}
            >
              <Text style={styles.aiDigestChatButtonText}>Задать вопрос AI-агроному</Text>
              <AppIcon name="chevron.right" size={12} color="#1B5E20" />
            </Pressable>
          </>
        ) : null}
      </View>
    </Card>
  );
}

/* =========================================================================
   2. FIELDS VIEW (Профили в самом верху, список участков)
   ========================================================================= */
interface FieldsViewProps {
  profiles: FarmProfile[];
  selectedProfile: FarmProfile | null;
  fields: Field[];
  loading: boolean;
  connected: boolean;
  error: string | null;
  totalArea: number;
  inspectionCount: number;
  onChooseProfile: (id: string) => void;
  onRefresh: () => void;
  onDeleteField: (field: Field) => void;
  onNewProfile: () => void;
  onNewField: () => void;
  onOpenField: (id: string) => void;
  onAskAi?: (question: string) => void;
  onAskFieldAi?: (field: Field) => void;
}

function FieldsView({
  profiles,
  selectedProfile,
  fields,
  loading,
  connected,
  error,
  totalArea,
  inspectionCount,
  onChooseProfile,
  onRefresh,
  onDeleteField,
  onNewProfile,
  onNewField,
  onOpenField,
  onAskAi,
  onAskFieldAi,
}: FieldsViewProps) {
  const [aiSummary, setAiSummary] = useState<AiFarmSummary | null>(null);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);

  const loadAiSummary = useCallback(async (refresh = false) => {
    if (!selectedProfile) {
      setAiSummary(null);
      return;
    }
    setAiSummaryLoading(true);
    try {
      const summary = await getAiFarmSummary(selectedProfile.id, refresh);
      setAiSummary(summary);
    } catch {
      // Keep cached summary on offline or error
    } finally {
      setAiSummaryLoading(false);
    }
  }, [selectedProfile?.id]);

  useEffect(() => {
    void loadAiSummary();
  }, [loadAiSummary]);

  const handleRefresh = useCallback(() => {
    onRefresh();
    void loadAiSummary(true);
  }, [onRefresh, loadAiSummary]);

  return (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      {/* 1. ПРОФИЛИ В САМОМ ВВЕРХУ (прям в самом верху экрана) */}
      <View style={styles.topProfilesSection}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.profileSegmentRow}
        >
          {profiles.map((profile) => {
            const selected = profile.id === selectedProfile?.id;
            return (
              <Pressable
                key={profile.id}
                onPress={() => onChooseProfile(profile.id)}
                style={[styles.profileSegmentTab, selected && styles.profileSegmentTabActive]}
              >
                <Text
                  style={[styles.profileSegmentText, selected && styles.profileSegmentTextActive]}
                  numberOfLines={1}
                >
                  {profile.name}
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            onPress={onNewProfile}
            style={({ pressed }) => [styles.addChip, pressed && styles.pressed]}
          >
            <Text style={styles.addChipText}>+ профиль</Text>
          </Pressable>
        </ScrollView>
      </View>

      {/* 2. Заголовок "Участки" и статус сервера (без значка профиля сверху!) */}
      <View style={styles.fieldsHeaderRow}>
        <View style={styles.fieldsHeaderTitleWrap}>
          <Text style={styles.screenTitle}>Участки</Text>
          <Text style={styles.screenSubtitle}>
            {selectedProfile ? `${selectedProfile.name} • ${selectedProfile.region || 'регион не указан'}` : 'Профиль не выбран'}
          </Text>
        </View>
        <View style={styles.connectionBadge}>
          <View style={[styles.statusDot, connected ? styles.statusDotOnline : styles.statusDotOffline]} />
          <Text style={styles.connectionText}>{connected ? 'Онлайн' : 'Офлайн'}</Text>
        </View>
      </View>

      {/* Сводная карточка */}
      <Card style={styles.summaryCard}>
        <SummaryCell value={fields.length} label="участков" />
        <View style={styles.summaryDivider} />
        <SummaryCell value={totalArea.toFixed(1)} label="га" />
        <View style={styles.summaryDivider} />
        <SummaryCell value={inspectionCount} label="осмотров" />
      </Card>

      {/* AI-Сводка хозяйства (Option 1 & 4) */}
      {selectedProfile && (
        <AiFarmDigestCard
          summary={aiSummary}
          loading={aiSummaryLoading}
          onRefresh={() => void loadAiSummary(true)}
          onAskQuestion={(q) => onAskAi?.(q)}
        />
      )}

      {/* Кнопки действий */}
      <View style={styles.actionsRow}>
        <Pressable
          disabled={!selectedProfile}
          onPress={onNewField}
          style={({ pressed }) => [styles.primaryButton, (!selectedProfile || pressed) && styles.buttonPressed]}
        >
          <Text style={styles.primaryButtonText}>Добавить участок</Text>
        </Pressable>
        <Pressable onPress={handleRefresh} style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}>
          <Text style={styles.secondaryButtonText}>Обновить</Text>
        </Pressable>
      </View>

      {/* Список участков */}
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>СПИСОК УЧАСТКОВ</Text>
        <Text style={styles.sectionHint} numberOfLines={1}>удержите для удаления</Text>
      </View>

      {loading ? (
        <Card style={styles.centerBox}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.helperText}>Загрузка данных…</Text>
        </Card>
      ) : error ? (
        <Card style={styles.errorBox}>
          <Text style={styles.errorTitle}>Нет связи с локальным API</Text>
          <Text style={styles.errorDescription}>{error}</Text>
          <Pressable onPress={handleRefresh} style={styles.retryButton}>
            <Text style={styles.retryButtonText}>Повторить</Text>
          </Pressable>
        </Card>
      ) : fields.length === 0 ? (
        <EmptyState
          title="Нет участков в этом профиле"
          text="Добавьте первое поле вручную или распознайте контур со спутника Sentinel-2."
        />
      ) : (
        <Card style={styles.fieldsGroup}>
          {fields.map((field, index) => {
            const cropAccent = getCropAccent(field.cropType);
            const cropCode = getCropCode(field.cropType);
            const aiBadge = aiSummary?.fieldBadges?.[field.id];

            let centerCoords: string | null = null;
            if (field.boundary && field.boundary.length > 0) {
              const cLat = field.boundary.reduce((s, p) => s + p.latitude, 0) / field.boundary.length;
              const cLon = field.boundary.reduce((s, p) => s + p.longitude, 0) / field.boundary.length;
              centerCoords = `${cLat.toFixed(3)}°N, ${cLon.toFixed(3)}°E`;
            }

            return (
              <View key={field.id} style={styles.fieldItemContainer}>
                <Pressable
                  onPress={() => onOpenField(field.id)}
                  onLongPress={() => onDeleteField(field)}
                  delayLongPress={350}
                  style={({ pressed }) => [styles.fieldRow, pressed && styles.rowPressed]}
                >
                  <View style={[styles.fieldAccent, { backgroundColor: cropAccent.accent }]} />
                  <View style={[styles.fieldCode, { backgroundColor: cropAccent.bg }]}>
                    <Text style={[styles.fieldCodeText, { color: cropAccent.text }]}>{cropCode}</Text>
                  </View>
                  <View style={styles.fieldMain}>
                    <View style={styles.fieldTitleRow}>
                      <Text style={styles.fieldName} numberOfLines={1}>
                        {field.name}
                      </Text>
                    </View>
                    <Text style={styles.fieldMeta} numberOfLines={1}>
                      {field.cropType || 'Культура не задана'} • {field.areaHa.toFixed(1)} га{field.perimeterKm ? ` • P: ${field.perimeterKm.toFixed(1)} км` : ''}
                    </Text>
                    {centerCoords && (
                      <Text style={styles.fieldGeoMeta} numberOfLines={1}>
                        GPS: {centerCoords}
                      </Text>
                    )}
                    <View style={styles.fieldBottomMetaRow}>
                      <Text style={styles.fieldMetaSmall} numberOfLines={1}>
                        Осмотров: {field.inspectionCount}
                      </Text>
                      {aiBadge && (
                        <Badge
                          label={aiBadge.label}
                          variant={aiBadge.type}
                          style={styles.fieldAiBadge}
                        />
                      )}
                    </View>
                  </View>
                  <AppIcon name="chevron.right" size={13} color="#C7C7CC" />
                </Pressable>

                <View style={styles.fieldCardActionsRow}>
                  <Pressable
                    onPress={() => onAskFieldAi?.(field)}
                    style={({ pressed }) => [styles.fieldAskAiBtn, pressed && styles.fieldAskAiBtnPressed]}
                  >
                    <AppIcon name="sparkles" size={12} color="#0D7D4D" />
                    <Text style={styles.fieldAskAiBtnText}>Спросить AI по этому участку</Text>
                  </Pressable>
                </View>

                {index < fields.length - 1 && <View style={styles.rowDivider} />}
              </View>
            );
          })}
        </Card>
      )}
    </ScrollView>
  );
}

/* =========================================================================
   3. PROFILE VIEW (Правая вкладка — Профиль)
   ========================================================================= */
interface ProfileViewProps {
  user: ReturnType<typeof useAuth>['user'];
  isLoading: boolean;
  onLogout: () => Promise<void>;
  onNewProfile: () => void;
}

function ProfileView({ user, isLoading, onLogout, onNewProfile }: ProfileViewProps) {
  if (isLoading || !user) {
    return (
      <View style={styles.centerBox}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const stats = user.stats;

  return (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerTitleBlock}>
        <Text style={styles.screenTitle}>Профиль</Text>
        <Text style={styles.screenSubtitle}>Учётная запись агронома</Text>
      </View>

      {/* Avatar block */}
      <View style={styles.avatarBlock}>
        <Avatar name={user.name} size={76} />
        <Text style={styles.userName}>{user.name}</Text>
        {user.organization ? <Text style={styles.userOrg}>{user.organization}</Text> : null}
        {user.region ? <Text style={styles.userRegion}>{user.region}</Text> : null}
      </View>

      {/* Stats row */}
      {stats ? (
        <Card style={styles.statsCard}>
          <StatCell value={stats.fieldCount} label="участков" />
          <StatCell
            value={stats.totalAreaHa % 1 === 0 ? stats.totalAreaHa : Number(stats.totalAreaHa.toFixed(1))}
            label="га"
          />
          <StatCell value={stats.inspectionCount} label="осмотров" />
          <StatCell value={stats.profileCount} label="профилей" />
        </Card>
      ) : null}

      {/* Button for new farm profile */}
      <Pressable
        onPress={onNewProfile}
        style={({ pressed }) => [styles.profileAddButton, pressed && styles.pressed]}
      >
        <Text style={styles.profileAddButtonText}>+ Создать новый профиль хозяйства</Text>
      </Pressable>

      {/* Account info */}
      <Text style={styles.sectionTitle}>ДАННЫЕ АККАУНТА</Text>
      <Card style={styles.infoCard}>
        <InfoRow label="Email" value={user.email} />
        <View style={styles.rowDivider} />
        <InfoRow label="Организация" value={user.organization || '—'} />
        <View style={styles.rowDivider} />
        <InfoRow label="Регион" value={user.region || '—'} />
        <View style={styles.rowDivider} />
        <InfoRow
          label="Дата регистрации"
          value={new Date(user.createdAt).toLocaleDateString('ru-RU', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}
        />
      </Card>

      {/* Logout */}
      <Pressable
        onPress={() => void onLogout()}
        style={({ pressed }) => [styles.logoutButton, pressed && styles.pressed]}
      >
        <Text style={styles.logoutText}>Выйти из аккаунта</Text>
      </Pressable>
    </ScrollView>
  );
}

/* =========================================================================
   Helper Components
   ========================================================================= */
function AppIcon({
  name,
  size = 20,
  color = colors.textSecondary,
}: {
  name: SFSymbol;
  size?: number;
  color?: string;
}) {
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color}
      style={{ width: size, height: size }}
    />
  );
}

function SummaryCell({ value, label }: { value: string | number; label: string }) {
  return (
    <View style={styles.summaryCell}>
      <Text style={styles.summaryValue} numberOfLines={1}>
        {String(value)}
      </Text>
      <Text style={styles.summaryLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function StatCell({ value, label }: { value: string | number; label: string }) {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
        {String(value)}
      </Text>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function getCropAccent(cropType: string) {
  const t = cropType.toLowerCase();
  if (t.includes('пшениц') || t.includes('ячмен') || t.includes('овёс') || t.includes('овес')) {
    return { accent: colors.cropWheatText, bg: colors.cropWheatBg, text: colors.cropWheatText };
  }
  if (t.includes('рапс') || t.includes('подсолнеч')) {
    return { accent: colors.cropRapeseedText, bg: colors.cropRapeseedBg, text: colors.cropRapeseedText };
  }
  return { accent: colors.cropPotatoText, bg: colors.cropPotatoBg, text: colors.cropPotatoText };
}

function getCropCode(cropType: string) {
  const normalized = cropType.trim().toUpperCase();
  if (!normalized) return 'ПЛ';
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2);
  return words.slice(0, 2).map((word) => word[0]).join('');
}

/* =========================================================================
   Styles (Standard iOS Inset Grouped, Clean & Calm)
   ========================================================================= */
const styles = StyleSheet.create({
  safeContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  tabContentArea: {
    flex: 1,
  },
  tabPane: {
    flex: 1,
  },
  tabPaneHidden: {
    display: 'none',
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 24,
    gap: 12,
  },

  /* Top Profiles Section (At the very top) */
  topProfilesSection: {
    marginHorizontal: -16,
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  profileSegmentRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 2,
    paddingRight: 16,
  },
  profileSegmentTab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  profileSegmentTabActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  profileSegmentText: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  profileSegmentTextActive: {
    color: '#FFFFFF',
    fontFamily: fontFamilies.bold,
  },
  addChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  addChipText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12.5,
    color: colors.primaryDark,
  },

  /* Headers */
  headerTitleBlock: {
    paddingTop: 4,
    gap: 4,
  },
  modelStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#E8F5E9',
    borderColor: '#A5D6A7',
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 6,
    marginTop: 4,
  },
  modelStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#2E7D32',
  },
  modelStatusText: {
    fontFamily: fontFamilies.medium,
    fontSize: 11.5,
    color: '#1B5E20',
  },
  clearChatText: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: colors.primaryDark,
  },
  fieldsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 2,
  },
  fieldsHeaderTitleWrap: {
    flex: 1,
    gap: 2,
  },
  screenTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 24,
    color: colors.text,
  },
  screenSubtitle: {
    fontFamily: fontFamilies.medium,
    fontSize: 12.5,
    color: colors.textSecondary,
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  statusDotOnline: {
    backgroundColor: colors.success,
  },
  statusDotOffline: {
    backgroundColor: colors.danger,
  },
  connectionText: {
    fontFamily: fontFamilies.medium,
    fontSize: 11,
    color: colors.textSecondary,
  },

  /* Summary Card */
  summaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
  summaryCell: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  summaryValue: {
    fontFamily: fontFamilies.bold,
    fontSize: 19,
    color: colors.text,
  },
  summaryLabel: {
    fontFamily: fontFamilies.medium,
    fontSize: 11.5,
    color: colors.textSecondary,
  },
  summaryDivider: {
    width: StyleSheet.hairlineWidth,
    height: 28,
    backgroundColor: colors.border,
  },

  /* Actions Row */
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  primaryButton: {
    flex: 2,
    minHeight: 46,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14,
    color: '#FFFFFF',
  },
  secondaryButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13.5,
    color: colors.primary,
  },
  buttonPressed: {
    opacity: 0.76,
  },

  /* Section Title */
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
    marginTop: 2,
  },
  sectionTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 12,
    color: colors.textSecondary,
    letterSpacing: 0.4,
  },
  sectionHint: {
    fontFamily: fontFamilies.regular,
    fontSize: 11,
    color: colors.muted,
  },

  /* Fields Group */
  fieldsGroup: {
    padding: 0,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 0,
    paddingRight: 14,
    paddingVertical: 12,
    minHeight: 70,
  },
  rowPressed: {
    backgroundColor: colors.surfaceSecondary,
  },
  fieldAccent: {
    alignSelf: 'stretch',
    width: 3.5,
    borderRadius: 2,
  },
  fieldCode: {
    width: 42,
    height: 42,
    borderRadius: 8,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fieldCodeText: {
    fontFamily: fontFamilies.bold,
    fontSize: 13,
    color: colors.primaryDark,
  },
  fieldMain: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  fieldTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  fieldName: {
    flex: 1,
    minWidth: 0,
    fontFamily: fontFamilies.semiBold,
    fontSize: 14.5,
    color: colors.text,
  },
  fieldMeta: {
    fontFamily: fontFamilies.regular,
    fontSize: 12.5,
    color: colors.textSecondary,
  },
  fieldMetaSmall: {
    fontFamily: fontFamilies.medium,
    fontSize: 11.5,
    color: colors.muted,
  },
  fieldBottomMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
    gap: 6,
  },
  fieldAiBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  fieldItemContainer: {
    paddingVertical: 2,
  },
  fieldGeoMeta: {
    fontFamily: fontFamilies.regular,
    fontSize: 11,
    color: colors.muted,
    marginTop: 1,
  },
  fieldCardActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 14,
    paddingBottom: 8,
    paddingTop: 4,
  },
  fieldAskAiBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4.5,
    borderRadius: 7,
    backgroundColor: '#F0F9F4',
    borderWidth: 1,
    borderColor: '#C3E6D2',
  },
  fieldAskAiBtnPressed: {
    backgroundColor: '#D7F0E2',
  },
  fieldAskAiBtnText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 11.5,
    color: '#0D7D4D',
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: 60,
  },

  /* AI Farm Digest Card */
  aiDigestCard: {
    marginHorizontal: 0,
    marginTop: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDF0DD',
    gap: 10,
  },
  aiDigestHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  aiDigestHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  aiDigestIconWrap: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#E8F5E9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiDigestHeaderTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 11.5,
    letterSpacing: 0.6,
    color: '#1B5E20',
  },
  aiDigestRefreshBtn: {
    padding: 4,
  },
  aiDigestBody: {
    gap: 10,
  },
  aiDigestLoadingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  aiDigestLoadingText: {
    fontFamily: fontFamilies.medium,
    fontSize: 12.5,
    color: colors.textSecondary,
  },
  aiDigestText: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.text,
  },
  aiDigestMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 2,
  },
  aiDigestMetaText: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: '#2E7D32',
    flex: 1,
  },
  aiDigestChipsSection: {
    gap: 6,
    marginTop: 2,
  },
  aiDigestChipsTitle: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 10,
    letterSpacing: 0.4,
    color: colors.textSecondary,
  },
  aiDigestChipsRow: {
    gap: 8,
    paddingRight: 6,
  },
  aiDigestChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    backgroundColor: '#F1F8F1',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#CDE5CD',
  },
  aiDigestChipPressed: {
    backgroundColor: '#E1F0E1',
  },
  aiDigestChipText: {
    fontFamily: fontFamilies.medium,
    fontSize: 11.5,
    color: '#1B5E20',
  },
  aiDigestChatButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F7FAF7',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#E2EBE2',
    marginTop: 2,
  },
  aiDigestChatButtonPressed: {
    backgroundColor: '#EDF5ED',
  },
  aiDigestChatButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    color: '#1B5E20',
  },

  /* AI Tools Screen Styles */
  aiHeroCard: {
    padding: 16,
    gap: 8,
    backgroundColor: '#F5FAF5',
    borderWidth: 1,
    borderColor: '#D8E8D8',
  },
  aiHeroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  aiHeroBadgeWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#E4F4E4',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  aiHeroPulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#2E7D32',
  },
  aiHeroBadgeText: {
    fontFamily: fontFamilies.bold,
    fontSize: 10,
    color: '#1B5E20',
    letterSpacing: 0.4,
  },
  aiHeroTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 20,
    color: colors.text,
  },
  aiHeroSubtitle: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },

  /* Photo Diagnosis Card */
  aiPhotoCard: {
    padding: 16,
    gap: 14,
  },
  aiPhotoPlaceholder: {
    alignItems: 'center',
    paddingVertical: 20,
    paddingHorizontal: 12,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#CCDCCC',
    borderRadius: 12,
    backgroundColor: '#FAFDF9',
    gap: 8,
  },
  aiPhotoIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  aiPhotoPlaceholderTitle: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14,
    color: colors.text,
    textAlign: 'center',
  },
  aiPhotoPlaceholderSub: {
    fontFamily: fontFamilies.regular,
    fontSize: 12,
    lineHeight: 16,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  aiPreviewContainer: {
    position: 'relative',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  aiPreviewImage: {
    width: '100%',
    height: 200,
    borderRadius: 12,
    backgroundColor: '#1F2937',
  },
  aiVideoBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  aiVideoBadgeText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 11,
    color: '#fff',
  },
  aiVideoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  aiVideoPlaceholderText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13,
    color: '#fff',
  },
  aiClearPhotoBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 14,
    padding: 4,
  },
  aiPhotoActionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  aiPhotoBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    borderRadius: 10,
  },
  aiPhotoBtnPrimary: {
    backgroundColor: colors.primaryDark,
  },
  aiPhotoBtnSecondary: {
    backgroundColor: colors.primarySoft,
  },
  aiPhotoBtnTextPrimary: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13,
    color: '#FFFFFF',
  },
  aiPhotoBtnTextSecondary: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13,
    color: colors.primaryDark,
  },
  aiDiagnosingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 12,
    backgroundColor: '#F0F8F0',
    borderRadius: 10,
  },
  aiDiagnosingText: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.primaryDark,
  },
  aiErrorNotice: {
    padding: 10,
    backgroundColor: '#FFF2F2',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FFD6D6',
  },
  aiErrorText: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: colors.danger,
    textAlign: 'center',
  },

  /* Diagnosis Result Card */
  aiDiagResultCard: {
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 12,
  },
  aiDiagHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  aiDiagCatPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: 12,
  },
  aiDiagCatText: {
    fontFamily: fontFamilies.bold,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  aiDiagCrop: {
    fontFamily: fontFamilies.bold,
    fontSize: 12,
    color: colors.primaryDark,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  aiDiagTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 17,
    color: colors.text,
  },
  aiDiagMetricsRow: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  aiStandCountBox: {
    alignItems: 'center',
    backgroundColor: '#F0FDF4',
    borderRadius: 14,
    paddingVertical: 14,
    gap: 2,
  },
  aiStandCountNumber: {
    fontFamily: fontFamilies.bold,
    fontSize: 40,
    lineHeight: 46,
    color: '#166534',
  },
  aiStandCountCaption: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    color: colors.textSecondary,
  },
  aiGrainBars: {
    gap: 8,
  },
  aiGrainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  aiGrainRowLabel: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: colors.text,
    width: 120,
  },
  aiGrainTrack: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surfaceSecondary,
    overflow: 'hidden',
  },
  aiGrainFill: {
    height: 8,
    borderRadius: 4,
  },
  aiGrainRowVal: {
    fontFamily: fontFamilies.bold,
    fontSize: 12,
    width: 44,
    textAlign: 'right',
  },
  aiGrainCount: {
    fontFamily: fontFamilies.regular,
    fontSize: 12,
    color: colors.textSecondary,
  },
  aiSpeciesList: {
    gap: 6,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    padding: 10,
  },
  aiSpeciesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  aiSpeciesEmoji: {
    fontSize: 20,
  },
  aiSpeciesName: {
    flex: 1,
    fontFamily: fontFamilies.medium,
    fontSize: 14,
    color: colors.text,
  },
  aiSpeciesCount: {
    fontFamily: fontFamilies.bold,
    fontSize: 16,
    color: '#6D28D9',
  },
  aiDiagMetricItem: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  aiDiagMetricLabel: {
    fontFamily: fontFamilies.regular,
    fontSize: 11,
    color: colors.textSecondary,
  },
  aiDiagMetricVal: {
    fontFamily: fontFamilies.bold,
    fontSize: 13,
    color: colors.text,
  },
  aiDiagDesc: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  aiProtocolBox: {
    backgroundColor: '#F9FCF9',
    borderWidth: 1,
    borderColor: '#E2EFE2',
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  aiProtocolHeading: {
    fontFamily: fontFamilies.bold,
    fontSize: 13,
    color: colors.text,
    marginBottom: 4,
  },
  aiProtocolRow: {
    gap: 2,
  },
  aiProtocolLabel: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    color: colors.primaryDark,
  },
  aiProtocolVal: {
    fontFamily: fontFamilies.regular,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.text,
  },
  aiAskDiagBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    backgroundColor: colors.primaryDark,
    borderRadius: 10,
  },
  aiAskDiagBtnText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13,
    color: colors.primaryDark,
  },
  aiAskDiagBtnTextAlt: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13,
    color: '#FFFFFF',
  },

  /* Back button for photo view */
  aiBackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  aiBackBtnText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14,
    color: colors.primaryDark,
  },

  /* AI Tools — menu with two entry points */
  aiMenuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    marginBottom: 4,
  },
  aiMenuTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 22,
    color: colors.text,
  },
  aiMenuSubtitle: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    color: colors.textSecondary,
  },
  aiMenuCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  aiMenuCardPressed: {
    backgroundColor: colors.surfaceSecondary,
  },
  aiMenuIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiMenuCardTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 16,
    color: colors.text,
  },
  aiMenuCardDesc: {
    fontFamily: fontFamilies.regular,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.textSecondary,
  },

  /* Photo upload prompt */
  aiUploadCard: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 24,
    paddingHorizontal: 20,
  },
  aiUploadTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 16,
    color: colors.text,
    textAlign: 'center',
  },
  aiUploadDesc: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 8,
  },
  aiCalibrationWrap: {
    alignSelf: 'stretch',
    gap: 6,
    marginBottom: 8,
  },
  aiCalibrationLabel: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    color: colors.text,
  },
  aiCalibrationInput: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontFamily: fontFamilies.regular,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  aiCalibrationHint: {
    fontFamily: fontFamilies.regular,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textSecondary,
  },
  aiUploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    alignSelf: 'stretch',
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: colors.primaryDark,
  },
  aiUploadBtnText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14,
    color: '#FFFFFF',
  },
  aiUploadBtnAlt: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    alignSelf: 'stretch',
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: '#C8E6C9',
  },
  aiUploadBtnAltText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14,
    color: colors.primaryDark,
  },
  aiChatBackBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -4,
  },

  /* AI Chat — Full-screen Messenger Layout */
  aiChatContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  aiChatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 8,
  },
  aiChatHeaderLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  aiChatHeaderAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#E8F5E9',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  aiChatHeaderTextWrap: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  aiChatHeaderTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 15,
    color: colors.text,
  },
  aiChatHeaderStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  aiChatHeaderDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#2E7D32',
    flexShrink: 0,
  },
  aiChatHeaderStatus: {
    fontFamily: fontFamilies.medium,
    fontSize: 11,
    color: colors.success,
  },
  aiChatHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  aiChatHeaderBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },

  /* Target field banner */
  targetFieldBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#EDF7F1',
    borderBottomWidth: 1,
    borderBottomColor: '#CBE7D7',
  },
  targetFieldBannerLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginRight: 8,
  },
  targetFieldBannerText: {
    flex: 1,
    fontFamily: fontFamilies.regular,
    fontSize: 12,
    color: '#165B37',
  },
  targetFieldBannerBold: {
    fontFamily: fontFamilies.bold,
    color: '#0E482A',
  },
  targetFieldClearBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#B3DFC6',
  },
  targetFieldClearText: {
    fontFamily: fontFamilies.medium,
    fontSize: 11,
    color: '#165B37',
  },

  /* Quick chips */
  aiClearHistoryText: {
    fontFamily: fontFamilies.medium,
    fontSize: 12.5,
    color: colors.muted,
  },
  aiChipsRow: {
    flexGrow: 0,
    flexShrink: 0,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  aiChipsScroll: {
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
    alignItems: 'center',
  },
  aiChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: '#C8E6C9',
  },
  aiChipPressed: {
    backgroundColor: '#C8E6C9',
  },
  aiChipText: {
    fontFamily: fontFamilies.medium,
    fontSize: 12.5,
    color: colors.primaryDark,
  },

  /* Chat list */
  aiChatList: {
    flex: 1,
    backgroundColor: colors.background,
  },
  aiChatListContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 16,
    gap: 10,
  },
  aiMessagesContainer: {
    gap: 10,
    minHeight: 120,
  },
  aiMessageWrap: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-end',
  },
  aiMessageWrapUser: {
    justifyContent: 'flex-end',
  },
  aiMessageWrapAi: {
    justifyContent: 'flex-start',
  },
  aiAvatarSmall: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#E8F5E9',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
    borderWidth: 1,
    borderColor: '#C8E6C9',
  },
  aiBubble: {
    maxWidth: '82%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 4,
  },
  aiBubbleUser: {
    backgroundColor: colors.primaryDark,
    borderBottomRightRadius: 4,
  },
  aiBubbleAi: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  aiBubbleError: {
    backgroundColor: '#FFF5F5',
    borderColor: '#FECACA',
  },
  aiBubbleThinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  aiBubbleText: {
    fontSize: 14,
    lineHeight: 20,
  },
  aiBubbleTextUser: {
    fontFamily: fontFamilies.regular,
    color: '#FFFFFF',
  },
  aiBubbleTextAi: {
    fontFamily: fontFamilies.regular,
    color: colors.text,
  },
  aiThinkingText: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: colors.textSecondary,
  },
  aiBubbleTime: {
    fontFamily: fontFamilies.medium,
    fontSize: 10,
    alignSelf: 'flex-end',
  },
  aiBubbleTimeUser: {
    color: 'rgba(255,255,255,0.65)',
  },
  aiBubbleTimeAi: {
    color: colors.muted,
  },

  /* Input Bar — pinned to bottom */
  aiInputBarWrap: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
  },
  aiInputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  aiAttachBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiTextInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 110,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontFamily: fontFamilies.regular,
    fontSize: 15,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  aiSendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primaryDark,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primaryDark,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  aiSendButtonDisabled: {
    backgroundColor: colors.border,
    shadowOpacity: 0,
    elevation: 0,
  },


  /* Profile Tab Styles */
  avatarBlock: {
    alignItems: 'center',
    paddingVertical: 12,
    gap: 4,
  },
  userName: {
    fontFamily: fontFamilies.bold,
    fontSize: 19,
    color: colors.text,
    marginTop: 6,
  },
  userOrg: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  userRegion: {
    fontFamily: fontFamilies.regular,
    fontSize: 12,
    color: colors.muted,
  },
  statsCard: {
    flexDirection: 'row',
    paddingVertical: 12,
    justifyContent: 'space-around',
  },
  statCell: {
    alignItems: 'center',
    gap: 2,
    flex: 1,
  },
  statValue: {
    fontFamily: fontFamilies.bold,
    fontSize: 16,
    color: colors.primaryDark,
  },
  statLabel: {
    fontFamily: fontFamilies.medium,
    fontSize: 11,
    color: colors.textSecondary,
  },
  profileAddButton: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  profileAddButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13,
    color: colors.primaryDark,
  },
  infoCard: {
    paddingVertical: 6,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  infoLabel: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    color: colors.textSecondary,
  },
  infoValue: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13,
    color: colors.text,
    maxWidth: '60%',
    textAlign: 'right',
  },
  logoutButton: {
    minHeight: 46,
    borderRadius: 10,
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
  },
  logoutText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13.5,
    color: '#DC2626',
  },

  /* Error & Loader */
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  helperText: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  errorBox: {
    padding: 16,
    gap: 8,
  },
  errorTitle: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14.5,
    color: colors.danger,
  },
  errorDescription: {
    fontFamily: fontFamilies.regular,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  retryButton: {
    minHeight: 42,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  retryButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13.5,
    color: '#FFFFFF',
  },

  /* Standard Apple Tab Bar */
  bottomBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 6,
    paddingHorizontal: 8,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 3,
    gap: 2,
  },
  tabLabel: {
    fontFamily: fontFamilies.medium,
    fontSize: 10.5,
    color: '#8E8E93',
  },
  tabLabelActive: {
    fontFamily: fontFamilies.bold,
    color: colors.primaryDark,
  },
  pressed: {
    opacity: 0.6,
  },
});
