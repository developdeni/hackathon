import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageStyle,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import * as ImagePicker from 'expo-image-picker';

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
  askAiAgronomist,
} from '../src/services/api';
import {
  clearLocalChatHistory,
  loadSavedChatMessages,
  saveChatMessages,
} from '../src/services/localAiModel';
import { getLocalCache, getMemoryCache } from '../src/services/offline';
import { colors } from '../src/theme/colors';
import { fontFamilies } from '../src/theme/typography';
import { AiDiagnosisResult, FarmProfile, Field } from '../src/types/domain';

type TabKey = 'ai_tools' | 'fields' | 'profile';

export default function MainScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, logout, refreshUser, isLoading: isAuthLoading } = useAuth();
  const params = useLocalSearchParams<{ profileId?: string; tab?: TabKey }>();

  // AI Tools opens by default as requested
  const [activeTab, setActiveTab] = useState<TabKey>(params.tab ?? 'ai_tools');

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
  }, [params.tab]);

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
        {activeTab === 'ai_tools' && (
          <AiToolsView onNavigateToFields={() => setActiveTab('fields')} />
        )}

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

      {/* STANDARD NATIVE IOS BOTTOM NAVIGATION BAR */}
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
    </SafeAreaView>
  );
}

/* =========================================================================
   1. AI TOOLS VIEW (AI-Агроном: Компьютерное зрение и экспертные консультации)
   ========================================================================= */
function AiToolsView({ onNavigateToFields }: { onNavigateToFields: () => void }) {
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [analyzingPhoto, setAnalyzingPhoto] = useState(false);
  const [diagnosis, setDiagnosis] = useState<AiDiagnosisResult | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [messages, setMessages] = useState<Array<{ id: string; sender: 'user' | 'ai'; text: string; time: string }>>([
    {
      id: 'm1',
      sender: 'ai',
      text: 'Здравствуйте! Я Tanap AI — агрономический ассистент на базе модели Hugging Face CropGuard. Модель скачана и вшита в приложение, работает на 100% офлайн без интернета. Сделайте фото листа для детекции болезней или задайте вопрос по нормам высева, удобрениям и индексам NDVI!',
      time: '00:00',
    },
  ]);

  useEffect(() => {
    let active = true;
    loadSavedChatMessages().then((saved) => {
      if (active && saved && saved.length > 0) {
        setMessages(
          saved.map((s) => ({
            id: s.id,
            sender: s.sender,
            text: s.text,
            time: s.timestamp || '00:00',
          }))
        );
      }
    });
    return () => {
      active = false;
    };
  }, []);

  async function handleClearChat() {
    await clearLocalChatHistory();
    const welcome = {
      id: `m_${Date.now()}`,
      sender: 'ai' as const,
      text: 'Диалог очищен. Задайте любой агрономический вопрос или отправьте фото листа!',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setMessages([welcome]);
  }

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Доступ ограничен', 'Разрешите доступ к камере в настройках устройства.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.82,
      base64: true,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setPhotoUri(asset.uri);
      if (asset.base64) {
        void runVisionDiagnosis(asset.base64);
      }
    }
  }

  async function pickPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Доступ ограничен', 'Разрешите доступ к медиатеке в настройках устройства.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.82,
      base64: true,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setPhotoUri(asset.uri);
      if (asset.base64) {
        void runVisionDiagnosis(asset.base64);
      }
    }
  }

  async function runVisionDiagnosis(base64: string) {
    setAnalyzingPhoto(true);
    setDiagnosis(null);
    try {
      const res = await diagnoseCropPhoto(base64);
      setDiagnosis(res);
    } catch (e) {
      Alert.alert('Ошибка анализа', e instanceof Error ? e.message : 'Не удалось распознать снимок');
    } finally {
      setAnalyzingPhoto(false);
    }
  }

  async function sendMessage(textToSend?: string) {
    const query = (textToSend ?? chatInput).trim();
    if (!query || sendingChat) return;

    const userTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const userMsg = {
      id: `u_${Date.now()}`,
      sender: 'user' as const,
      text: query,
      time: userTime,
    };
    setMessages((prev) => {
      const next = [...prev, userMsg];
      void saveChatMessages(
        next.map((m) => ({
          id: m.id,
          sender: m.sender,
          text: m.text,
          timestamp: m.time,
        }))
      );
      return next;
    });
    setChatInput('');
    setSendingChat(true);

    try {
      const ans = await askAiAgronomist(query);
      const aiTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const aiMsg = {
        id: `ai_${Date.now()}`,
        sender: 'ai' as const,
        text: ans,
        time: aiTime,
      };
      setMessages((prev) => {
        const next = [...prev, aiMsg];
        void saveChatMessages(
          next.map((m) => ({
            id: m.id,
            sender: m.sender,
            text: m.text,
            timestamp: m.time,
          }))
        );
        return next;
      });
    } catch {
      const errMsg = {
        id: `ai_${Date.now()}`,
        sender: 'ai' as const,
        text: 'Не удалось сформировать ответ. Повторите запрос.',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setSendingChat(false);
    }
  }

  const quickQuestions = [
    'Что делать при NDVI < 0.35?',
    'Жёлтая ржавчина на пшенице',
    'Септориоз листьев',
    'Осот и вьюнок в поле',
    'Сроки и нормы сева',
    'Подкормка карбамидом',
  ];

  return (
    <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      {/* Title */}
      <View style={styles.headerTitleBlock}>
        <Text style={styles.screenTitle}>AI Агроном</Text>
        <Text style={styles.screenSubtitle}>Компьютерное зрение и экспертные консультации</Text>
        <View style={styles.modelStatusBadge}>
          <View style={styles.modelStatusDot} />
          <Text style={styles.modelStatusText}>Hugging Face CropGuard & Agro-SLM • 100% Офлайн</Text>
        </View>
      </View>

      {/* 1. БЛОК РАСПОЗНАВАНИЯ ФОТО */}
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>ФОТОДИАГНОСТИКА БОЛЕЗНЕЙ И СОРНЯКОВ</Text>
      </View>

      <Card style={styles.aiPhotoCard}>
        <View style={styles.aiPhotoHeader}>
          <View style={styles.aiPhotoIconCircle}>
            <AppIcon name="viewfinder" size={22} color={colors.primaryDark} />
          </View>
          <View style={styles.aiPhotoTextWrap}>
            <Text style={styles.aiPhotoTitle}>Распознавание по фотографии</Text>
            <Text style={styles.aiPhotoDescription}>
              Сделайте снимок листа или очага в поле. Модель определит патоген, степень поражения и регламент обработки.
            </Text>
          </View>
        </View>

        <View style={styles.aiButtonsRow}>
          <Pressable
            disabled={analyzingPhoto}
            onPress={takePhoto}
            style={({ pressed }) => [styles.aiActionButton, pressed && styles.pressed]}
          >
            <AppIcon name="camera" size={16} color="#FFFFFF" />
            <Text style={styles.aiActionButtonText}>Камера</Text>
          </Pressable>

          <Pressable
            disabled={analyzingPhoto}
            onPress={pickPhoto}
            style={({ pressed }) => [styles.aiSecondaryActionButton, pressed && styles.pressed]}
          >
            <AppIcon name="photo" size={16} color={colors.text} />
            <Text style={styles.aiSecondaryActionButtonText}>Медиатека</Text>
          </Pressable>
        </View>

        {analyzingPhoto && (
          <View style={styles.analyzingBox}>
            <ActivityIndicator size="small" color={colors.primaryDark} />
            <Text style={styles.analyzingText}>Нейросетевой спектральный анализ листа…</Text>
          </View>
        )}

        {/* Результат распознавания */}
        {diagnosis && photoUri && (
          <View style={styles.diagnosisCard}>
            <View style={styles.diagnosisTopRow}>
              <Image source={{ uri: photoUri }} style={styles.diagnosisThumb as ImageStyle} />
              <View style={styles.diagnosisInfo}>
                <View style={styles.diagnosisBadgeRow}>
                  <Badge
                    label={
                      diagnosis.severity === 'high'
                        ? 'Высокий риск'
                        : diagnosis.severity === 'moderate'
                        ? 'Умеренный риск'
                        : 'В норме'
                    }
                    variant={
                      diagnosis.severity === 'high'
                        ? 'danger'
                        : diagnosis.severity === 'moderate'
                        ? 'warning'
                        : 'success'
                    }
                  />
                  <Text style={styles.confidenceText}>
                    {(diagnosis.confidence * 100).toFixed(0)}% уверенность
                  </Text>
                </View>
                <Text style={styles.diagnosisTitle}>{diagnosis.diagnosis}</Text>
                <Text style={styles.diagnosisCrop}>
                  Культура: {diagnosis.crop} • Поражение: {diagnosis.affected_area_percent}%
                </Text>
                {diagnosis.pathogen && (
                  <Text style={styles.diagnosisPathogen}>Патоген: {diagnosis.pathogen}</Text>
                )}
              </View>
            </View>

            <View style={styles.diagnosisDivider} />

            {/* Рекомендации и химия */}
            <View style={styles.prescriptionBlock}>
              <Text style={styles.prescriptionLabel}>РЕКОМЕНДОВАННЫЙ РЕГЛАМЕНТ:</Text>
              <Text style={styles.prescriptionText}>• {diagnosis.recommendation}</Text>
              {diagnosis.chemicals !== '—' && (
                <Text style={styles.prescriptionText}>• СЗР: {diagnosis.chemicals} ({diagnosis.rate})</Text>
              )}
              {diagnosis.weather_limits !== '—' && (
                <Text style={styles.prescriptionText}>• Окно внесения: {diagnosis.weather_limits}</Text>
              )}
              {diagnosis.yield_loss !== '0%' && (
                <Text style={[styles.prescriptionText, { color: colors.danger }]}>
                  • Оценка потерь: {diagnosis.yield_loss}
                </Text>
              )}
            </View>

            <Pressable
              onPress={() => {
                setDiagnosis(null);
                setPhotoUri(null);
              }}
              style={styles.clearDiagButton}
            >
              <Text style={styles.clearDiagText}>Сбросить результат</Text>
            </Pressable>
          </View>
        )}
      </Card>

      {/* 2. БЫСТРЫЕ ПОДСКАЗКИ */}
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>ЧАСТЫЕ ВОПРОСЫ ПО РЕГИОНУ</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
        {quickQuestions.map((q, idx) => (
          <Pressable
            key={idx}
            onPress={() => void sendMessage(q)}
            style={({ pressed }) => [styles.chipButton, pressed && styles.pressed]}
          >
            <Text style={styles.chipText}>{q}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* 3. ЧАТ С АГРОНОМОМ */}
      <View style={[styles.sectionHeaderRow, { justifyContent: 'space-between', alignItems: 'center' }]}>
        <Text style={styles.sectionTitle}>КОНСУЛЬТАЦИЯ AI-АГРОНОМА</Text>
        <Pressable onPress={handleClearChat} hitSlop={8} style={({ pressed }) => pressed && styles.pressed}>
          <Text style={styles.clearChatText}>Очистить историю</Text>
        </Pressable>
      </View>

      <Card style={styles.chatCard}>
        <View style={styles.chatMessagesArea}>
          {messages.map((m) => {
            const isUser = m.sender === 'user';
            return (
              <View key={m.id} style={[styles.chatBubble, isUser ? styles.userBubble : styles.aiBubble]}>
                <Text style={[styles.chatBubbleText, isUser ? styles.userBubbleText : styles.aiBubbleText]}>
                  {m.text}
                </Text>
                <Text style={[styles.chatTime, isUser ? styles.userChatTime : styles.aiChatTime]}>
                  {m.time}
                </Text>
              </View>
            );
          })}
          {sendingChat && (
            <View style={[styles.chatBubble, styles.aiBubble, { flexDirection: 'row', gap: 6, alignItems: 'center' }]}>
              <ActivityIndicator size="small" color={colors.primaryDark} />
              <Text style={styles.aiBubbleText}>Формирую агрономический ответ…</Text>
            </View>
          )}
        </View>

        {/* Input row */}
        <View style={styles.chatInputRow}>
          <TextInput
            value={chatInput}
            onChangeText={setChatInput}
            placeholder="Задайте вопрос по нормам, болезням, сорнякам…"
            placeholderTextColor={colors.muted}
            style={styles.chatTextInput}
            onSubmitEditing={() => void sendMessage()}
            returnKeyType="send"
          />
          <Pressable
            disabled={sendingChat || !chatInput.trim()}
            onPress={() => void sendMessage()}
            style={({ pressed }) => [
              styles.chatSendButton,
              (!chatInput.trim() || sendingChat || pressed) && styles.buttonPressed,
            ]}
          >
            <AppIcon name="paperplane.fill" size={15} color="#FFFFFF" />
          </Pressable>
        </View>
      </Card>

      <Pressable
        onPress={onNavigateToFields}
        style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed, { marginTop: 4 }]}
      >
        <Text style={styles.secondaryButtonText}>Перейти к моим участкам</Text>
      </Pressable>
    </ScrollView>
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
}: FieldsViewProps) {
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

      {/* Кнопки действий */}
      <View style={styles.actionsRow}>
        <Pressable
          disabled={!selectedProfile}
          onPress={onNewField}
          style={({ pressed }) => [styles.primaryButton, (!selectedProfile || pressed) && styles.buttonPressed]}
        >
          <Text style={styles.primaryButtonText}>Добавить участок</Text>
        </Pressable>
        <Pressable onPress={onRefresh} style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}>
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
          <Pressable onPress={onRefresh} style={styles.retryButton}>
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
            return (
              <View key={field.id}>
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
                      {field.isDemo && <Badge label="стартовое" variant="neutral" />}
                    </View>
                    <Text style={styles.fieldMeta} numberOfLines={1}>
                      {field.cropType || 'Культура не задана'} • {field.areaHa.toFixed(1)} га
                    </Text>
                    <Text style={styles.fieldMetaSmall} numberOfLines={1}>
                      Осмотров: {field.inspectionCount}
                    </Text>
                  </View>
                  <AppIcon name="chevron.right" size={13} color="#C7C7CC" />
                </Pressable>
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
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: 60,
  },

  /* AI Tools Interactive UI */
  aiPhotoCard: {
    padding: 14,
    gap: 12,
  },
  aiPhotoHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  aiPhotoIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiPhotoTextWrap: {
    flex: 1,
    gap: 3,
  },
  aiPhotoTitle: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 14.5,
    color: colors.text,
  },
  aiPhotoDescription: {
    fontFamily: fontFamilies.regular,
    fontSize: 12,
    lineHeight: 16.5,
    color: colors.textSecondary,
  },
  aiButtonsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  aiActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  aiActionButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13,
    color: '#FFFFFF',
  },
  aiSecondaryActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  aiSecondaryActionButtonText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13,
    color: colors.text,
  },
  analyzingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
  },
  analyzingText: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: colors.primaryDark,
  },
  diagnosisCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    padding: 12,
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  diagnosisTopRow: {
    flexDirection: 'row',
    gap: 12,
  },
  diagnosisThumb: {
    width: 78,
    height: 78,
    borderRadius: 8,
    backgroundColor: colors.border,
  },
  diagnosisInfo: {
    flex: 1,
    gap: 3,
  },
  diagnosisBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  confidenceText: {
    fontFamily: fontFamilies.medium,
    fontSize: 11,
    color: colors.muted,
  },
  diagnosisTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 14.5,
    color: colors.text,
    marginTop: 2,
  },
  diagnosisCrop: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: colors.textSecondary,
  },
  diagnosisPathogen: {
    fontFamily: fontFamilies.regular,
    fontStyle: 'italic',
    fontSize: 11.5,
    color: colors.muted,
  },
  diagnosisDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  prescriptionBlock: {
    gap: 4,
  },
  prescriptionLabel: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 11,
    letterSpacing: 0.5,
    color: colors.textSecondary,
  },
  prescriptionText: {
    fontFamily: fontFamilies.regular,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.text,
  },
  clearDiagButton: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  clearDiagText: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: colors.danger,
  },

  /* Chips */
  chipsRow: {
    paddingHorizontal: 2,
    gap: 8,
    paddingVertical: 2,
  },
  chipButton: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  chipText: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: colors.text,
  },

  /* Chat */
  chatCard: {
    padding: 12,
    gap: 12,
  },
  chatMessagesArea: {
    gap: 10,
    minHeight: 80,
  },
  chatBubble: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 12,
    maxWidth: '88%',
    gap: 3,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: colors.primary,
    borderBottomRightRadius: 2,
  },
  aiBubble: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderBottomLeftRadius: 2,
  },
  chatBubbleText: {
    fontSize: 13,
    lineHeight: 18,
  },
  userBubbleText: {
    fontFamily: fontFamilies.regular,
    color: '#FFFFFF',
  },
  aiBubbleText: {
    fontFamily: fontFamilies.regular,
    color: colors.text,
  },
  chatTime: {
    fontSize: 10,
    alignSelf: 'flex-end',
  },
  userChatTime: {
    fontFamily: fontFamilies.medium,
    color: 'rgba(255,255,255,0.7)',
  },
  aiChatTime: {
    fontFamily: fontFamilies.medium,
    color: colors.muted,
  },
  chatInputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 10,
  },
  chatTextInput: {
    flex: 1,
    height: 38,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    color: colors.text,
  },
  chatSendButton: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
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
