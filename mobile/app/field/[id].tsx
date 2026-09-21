import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '../../src/components/AppText';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import MapView, { Marker, Polygon } from '../../src/components/AppMapView';

import { Badge } from '../../src/components/Badge';
import { Card } from '../../src/components/Card';
import { EmptyState } from '../../src/components/EmptyState';
import { Screen } from '../../src/components/Screen';
import {
  buildAuthorizedDownloadUrl,
  deleteField,
  deleteInspection,
  getField,
  getFieldClassification,
  getFieldClimateRisk,
  getFieldOperationsRecommendation,
  getFieldSatellite,
  getFieldWeather,
  getFieldYieldForecast,
  getFieldZones,
  listInspections,
  syncOfflineQueue,
  CACHE_KEYS,
} from '../../src/services/api';
import { getLocalCache, getMemoryCache, saveLocalCache } from '../../src/services/offline';
import { colors } from '../../src/theme/colors';
import { fontFamilies } from '../../src/theme/typography';
import { confirmDestructive, notify } from '../../src/utils/notify';
import {
  AgroWeather,
  AvailablePeriod,
  ClimateRiskForecast,
  Field,
  FieldOperationsRecommendation,
  Inspection,
  LandUseClassification,
  RiskZone,
  SatelliteData,
  SatelliteObservation,
  YieldForecast,
  ZonesData,
} from '../../src/types/domain';

type MapMode = 'zones' | 'satellite' | 'boundary';

function measurement(value: number | null | undefined, unit = '', digits = 1): string {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}${unit}`;
}

function shortDay(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short' })
    .format(new Date(`${iso}T12:00:00`));
}

function riskLevelMeta(level: string): { label: string; color: string; bg: string } {
  switch (level) {
    case 'high':
      return { label: 'Высокий', color: '#B91C1C', bg: '#FEE2E2' };
    case 'moderate':
      return { label: 'Умеренный', color: '#B45309', bg: '#FEF3C7' };
    default:
      return { label: 'Низкий', color: '#166534', bg: '#DCFCE7' };
  }
}

function RiskMiniBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={rmbStyles.row}>
      <Text style={rmbStyles.label} numberOfLines={1}>{label}</Text>
      <View style={rmbStyles.track}>
        <View style={[rmbStyles.fill, { width: `${Math.min(Math.max(value, 0), 100)}%`, backgroundColor: color }]} />
      </View>
      <Text style={[rmbStyles.val, { color }]}>{value}</Text>
    </View>
  );
}

const rmbStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  label: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.text, width: 96 },
  track: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.surfaceSecondary, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  val: { fontFamily: fontFamilies.bold, fontSize: 11, width: 24, textAlign: 'right' },
});

const NDVI_LEGEND_COLORS = ['#BD0026', '#F03B20', '#FD8D3C', '#FED976', '#78C679', '#238443'];

// ---------------------------------------------------------------------------
// Small reusable components
// ---------------------------------------------------------------------------

function SectionLabel({ title, right }: { title: string; right?: string }) {
  return (
    <View style={sStyles.wrap}>
      <Text style={sStyles.title} numberOfLines={1}>{title}</Text>
      {right ? <Text style={sStyles.right} numberOfLines={1}>{right}</Text> : null}
    </View>
  );
}

const sStyles = StyleSheet.create({
  wrap: { paddingHorizontal: 2, gap: 1 },
  title: { fontFamily: fontFamilies.semiBold, fontSize: 11.5, letterSpacing: 0.6, color: colors.textSecondary },
  right: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.muted },
});

function MetricCell({ value, unit, label }: { value: string; unit: string; label: string }) {
  return (
    <View style={mStyles.cell}>
      <View style={mStyles.valueRow}>
        <Text style={mStyles.value}>{value}</Text>
        {unit ? <Text style={mStyles.unit}>{unit}</Text> : null}
      </View>
      <Text style={mStyles.label}>{label}</Text>
    </View>
  );
}

const mStyles = StyleSheet.create({
  cell: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  value: { fontFamily: fontFamilies.bold, fontSize: 18, color: colors.text },
  unit: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.textSecondary, marginBottom: 1 },
  label: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.muted, marginTop: 2 },
});

function InfoRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={iStyles.row}>
      <Text style={iStyles.label} numberOfLines={1}>{label}</Text>
      <Text style={[iStyles.value, valueColor ? { color: valueColor } : null]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

const iStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 9 },
  label: { fontFamily: fontFamilies.regular, fontSize: 13.5, color: colors.textSecondary, flex: 1 },
  value: { fontFamily: fontFamilies.semiBold, fontSize: 13.5, color: colors.text, flex: 1.2, textAlign: 'right' },
});

function WeatherCell({ value, label, wide }: { value: string; label: string; wide?: boolean }) {
  return (
    <View style={[wStyles.cell, wide && wStyles.wide]}>
      <Text style={wStyles.value} numberOfLines={1}>{value}</Text>
      <Text style={wStyles.label}>{label}</Text>
    </View>
  );
}

const wStyles = StyleSheet.create({
  cell: { width: '50%', paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  wide: { width: '100%' },
  value: { fontFamily: fontFamilies.bold, fontSize: 16, color: colors.text },
  label: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.muted, marginTop: 2 },
});

function SegTab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[segStyles.tab, active && segStyles.tabActive]}
    >
      <Text style={[segStyles.text, active && segStyles.textActive]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const segStyles = StyleSheet.create({
  tab: { flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.12, shadowRadius: 2, elevation: 2 },
  text: { fontFamily: fontFamilies.medium, fontSize: 12.5, color: colors.textSecondary },
  textActive: { fontFamily: fontFamilies.semiBold, color: colors.text },
});

function ZonePill({ zone, active, onPress }: { zone: RiskZone; active: boolean; onPress: () => void }) {
  const isCritical = zone.severity === 'critical';
  return (
    <Pressable
      onPress={onPress}
      style={[zpStyles.pill, active && (isCritical ? zpStyles.pillCritical : zpStyles.pillModerate)]}
    >
      <View style={[zpStyles.dot, { backgroundColor: isCritical ? colors.danger : colors.warning }]} />
      <Text style={[zpStyles.text, active && zpStyles.textActive]} numberOfLines={1}>{zone.title}</Text>
    </Pressable>
  );
}

const zpStyles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pillCritical: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  pillModerate: { borderColor: colors.warning, backgroundColor: colors.warningSoft },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  text: { fontFamily: fontFamilies.medium, fontSize: 12, color: colors.textSecondary, flex: 1 },
  textActive: { fontFamily: fontFamilies.semiBold, color: colors.text },
});

function ActionRow({
  title,
  subtitle,
  destructive,
  highlight,
  onPress,
}: {
  title: string;
  subtitle?: string;
  destructive?: boolean;
  highlight?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        arStyles.row,
        highlight && arStyles.highlightRow,
        pressed && arStyles.pressed,
      ]}
    >
      <View style={{ flex: 1, gap: subtitle ? 2 : 0 }}>
        <Text
          style={[
            arStyles.text,
            highlight && arStyles.textHighlight,
            destructive && arStyles.textDestructive,
          ]}
        >
          {title}
        </Text>
        {subtitle ? <Text style={arStyles.subtitle}>{subtitle}</Text> : null}
      </View>
      <Text
        style={[
          arStyles.chevron,
          highlight && arStyles.chevronHighlight,
          destructive && arStyles.chevronDestructive,
        ]}
      >
        ›
      </Text>
    </Pressable>
  );
}

const arStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13, gap: 8 },
  pressed: { backgroundColor: colors.surfaceSecondary },
  highlightRow: { backgroundColor: '#F1F8E9' },
  text: { flex: 1, fontFamily: fontFamilies.medium, fontSize: 14.5, color: colors.text },
  textHighlight: { color: colors.primaryDark, fontFamily: fontFamilies.semiBold },
  textDestructive: { color: colors.danger },
  subtitle: { fontFamily: fontFamilies.regular, fontSize: 11.5, color: colors.muted },
  chevron: { fontFamily: fontFamilies.regular, fontSize: 20, color: colors.muted },
  chevronHighlight: { color: colors.primaryDark },
  chevronDestructive: { color: '#F4B4B4' },
});

function IndexHistory({ observations }: { observations: SatelliteObservation[] }) {
  const recent = observations.slice(-6).reverse();
  return (
    <Card style={historyStyles.card}>
      <View style={historyStyles.legendRow}>
        <View style={historyStyles.legendItem}>
          <View style={[historyStyles.legendDot, { backgroundColor: colors.primary }]} />
          <Text style={historyStyles.legendText}>NDVI</Text>
        </View>
        <View style={historyStyles.legendItem}>
          <View style={[historyStyles.legendDot, { backgroundColor: colors.info }]} />
          <Text style={historyStyles.legendText}>NDMI</Text>
        </View>
        <Text style={historyStyles.legendNote}>последние {Math.min(observations.length, 18)}</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={historyStyles.chartContent}>
        {observations.slice(-18).map((item, index) => {
          const ndviHeight = Math.max(4, Math.min(76, ((item.ndviMean + 0.35) / 1.35) * 76));
          const ndmiHeight = item.ndmiMean == null ? 0 : Math.max(4, Math.min(76, ((item.ndmiMean + 0.55) / 1.35) * 76));
          return (
            <View key={`${item.date}-${index}`} style={historyStyles.chartColumn}>
              <View style={historyStyles.barArea}>
                <View style={[historyStyles.bar, { height: ndviHeight, backgroundColor: colors.primary }]} />
                {item.ndmiMean != null && <View style={[historyStyles.bar, { height: ndmiHeight, backgroundColor: colors.info }]} />}
              </View>
              <Text style={historyStyles.dateLabel}>{item.date.slice(5).replace('-', '.')}</Text>
            </View>
          );
        })}
      </ScrollView>

      <View style={historyStyles.tableHeader}>
        <Text style={[historyStyles.headerCell, historyStyles.dateCell]}>Дата</Text>
        <Text style={historyStyles.headerCell}>NDVI</Text>
        <Text style={historyStyles.headerCell}>NDMI</Text>
        <Text style={historyStyles.headerCell}>Облака над полем</Text>
      </View>
      {recent.map((item, index) => (
        <View key={`row-${item.date}-${index}`} style={[historyStyles.tableRow, index > 0 && historyStyles.tableDivider]}>
          <Text style={[historyStyles.valueCell, historyStyles.dateCell]}>{item.date}</Text>
          <Text style={historyStyles.valueCell}>{item.ndviMean.toFixed(2)}</Text>
          <Text style={historyStyles.valueCell}>{item.ndmiMean == null ? '—' : item.ndmiMean.toFixed(2)}</Text>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Text style={historyStyles.valueCell}>
              {item.cloudCoveragePercent == null ? '—' : `${item.cloudCoveragePercent.toFixed(0)}%`}
            </Text>
            {item.cloudStatus ? (
              <Text style={historyStyles.cloudStatusText}>{item.cloudStatus}</Text>
            ) : null}
          </View>
        </View>
      ))}
      <View style={historyStyles.cloudFootnote}>
        <Text style={historyStyles.cloudFootnoteText}>
          Sentinel-2 L2A · leastCC: выбирается наименее облачный пролёт за 10 дней. Облачность измеряется строго в контуре поля по классификатору ESA SCL (10 м).
        </Text>
      </View>
    </Card>
  );
}

const historyStyles = StyleSheet.create({
  card: { padding: 0, overflow: 'hidden' },
  legendRow: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: colors.text },
  legendNote: { marginLeft: 'auto', fontFamily: fontFamilies.regular, fontSize: 11, color: colors.textSecondary },
  chartContent: { minHeight: 116, paddingHorizontal: 12, paddingBottom: 8, gap: 7 },
  chartColumn: { width: 29, alignItems: 'center', justifyContent: 'flex-end', gap: 5 },
  barArea: { height: 80, flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  bar: { width: 8, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  dateLabel: { fontFamily: fontFamilies.medium, fontSize: 9.5, color: colors.muted },
  tableHeader: { flexDirection: 'row', backgroundColor: colors.surfaceSecondary, paddingHorizontal: 14, paddingVertical: 7 },
  tableRow: { flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 8 },
  tableDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  headerCell: { flex: 1, textAlign: 'right', fontFamily: fontFamilies.semiBold, fontSize: 10.5, color: colors.textSecondary },
  valueCell: { flex: 1, textAlign: 'right', fontFamily: fontFamilies.medium, fontSize: 11.5, color: colors.text },
  dateCell: { flex: 1.45, textAlign: 'left' },
  cloudStatusText: { fontSize: 9.5, fontFamily: fontFamilies.regular, color: colors.muted, textAlign: 'right' },
  cloudFootnote: { paddingHorizontal: 14, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  cloudFootnoteText: { fontFamily: fontFamilies.regular, fontSize: 10.5, color: colors.muted, lineHeight: 15 },
});

// ---------------------------------------------------------------------------
// Main Screen
// ---------------------------------------------------------------------------

export default function FieldScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  // Instant hydration from fast memory cache (0ms perceived latency)
  const initialField = id ? getMemoryCache<Field>(CACHE_KEYS.FIELD(id)) : null;
  const initialInspections = id ? getMemoryCache<Inspection[]>(CACHE_KEYS.INSPECTIONS(id)) ?? [] : [];
  const initialSat = id ? getMemoryCache<SatelliteData>(CACHE_KEYS.SATELLITE(id)) : null;
  const initialZones = id ? getMemoryCache<ZonesData>(CACHE_KEYS.ZONES(id)) : null;
  const initialWeather = id ? getMemoryCache<AgroWeather>(CACHE_KEYS.WEATHER(id)) : null;
  const initialClass = id ? getMemoryCache<LandUseClassification>(CACHE_KEYS.CLASSIFICATION(id)) : null;
  const initialYield = id ? getMemoryCache<YieldForecast>(CACHE_KEYS.YIELD_FORECAST(id)) : null;
  const initialOperations = id ? getMemoryCache<FieldOperationsRecommendation>(CACHE_KEYS.OPERATIONS(id)) : null;

  const [field, setField] = useState<Field | null>(initialField);
  const [inspections, setInspections] = useState<Inspection[]>(initialInspections);
  const [satellite, setSatellite] = useState<SatelliteData | null>(initialSat);
  const [zonesData, setZonesData] = useState<ZonesData | null>(initialZones);
  const [weather, setWeather] = useState<AgroWeather | null>(initialWeather);
  const [classification, setClassification] = useState<LandUseClassification | null>(initialClass);
  const [climateRisk, setClimateRisk] = useState<ClimateRiskForecast | null>(null);
  const [yieldForecast, setYieldForecast] = useState<YieldForecast | null>(initialYield);
  const [operations, setOperations] = useState<FieldOperationsRecommendation | null>(initialOperations);
  const [mapMode, setMapMode] = useState<MapMode>('zones');
  const [mapType, setMapType] = useState<'standard' | 'satellite'>('standard');
  const [selectedZone, setSelectedZone] = useState<RiskZone | null>(initialZones?.zones?.[0] ?? null);
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null); // null = default (latest from backend)
  const [periodLoading, setPeriodLoading] = useState(false);
  const [loading, setLoading] = useState(!initialField);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs let `load` stay stable (dep only on id) so useFocusEffect doesn't re-fire
  // in a loop each time we setField/setSelectedZone — that loop caused the flicker.
  const fieldRef = useRef(field);
  useEffect(() => { fieldRef.current = field; }, [field]);
  const isLoadingRef = useRef(false);

  const load = useCallback(async () => {
    if (!id || isLoadingRef.current) return;
    isLoadingRef.current = true;

    try {
      // 1. If memory was empty on cold start, try disk cache immediately
      if (!fieldRef.current) {
        const cachedField = await getLocalCache<Field>(CACHE_KEYS.FIELD(id));
        if (cachedField) {
          setField(cachedField);
          const [cachedInsp, cachedSat, cachedZones, cachedW, cachedCl, cachedYield, cachedOperations] = await Promise.all([
            getLocalCache<Inspection[]>(CACHE_KEYS.INSPECTIONS(id)),
            getLocalCache<SatelliteData>(CACHE_KEYS.SATELLITE(id)),
            getLocalCache<ZonesData>(CACHE_KEYS.ZONES(id)),
            getLocalCache<AgroWeather>(CACHE_KEYS.WEATHER(id)),
            getLocalCache<LandUseClassification>(CACHE_KEYS.CLASSIFICATION(id)),
            getLocalCache<YieldForecast>(CACHE_KEYS.YIELD_FORECAST(id)),
            getLocalCache<FieldOperationsRecommendation>(CACHE_KEYS.OPERATIONS(id)),
          ]);
          const cachedRisk = await getLocalCache<ClimateRiskForecast>(CACHE_KEYS.CLIMATE_RISK(id));
          if (cachedInsp) setInspections(cachedInsp);
          if (cachedSat) setSatellite(cachedSat);
          if (cachedZones) {
            setZonesData(cachedZones);
            if (cachedZones.zones.length > 0) setSelectedZone((prev) => prev ?? cachedZones.zones[0]);
          }
          if (cachedW) setWeather(cachedW);
          if (cachedCl) setClassification(cachedCl);
          if (cachedYield) setYieldForecast(cachedYield);
          if (cachedOperations) setOperations(cachedOperations);
          if (cachedRisk) setClimateRisk(cachedRisk);
          setLoading(false);
        } else {
          setLoading(true);
        }
      }

      setError(null);
      setRefreshing(true);
      void syncOfflineQueue().catch(() => {});

      // Не ждём самый медленный запрос (спутник) — показываем экран сразу, как только
      // пришло само поле (быстрый запрос к БД), а тяжёлые секции дозагружаются отдельно.
      const fieldTask = getField(id)
        .then((value) => setField(value))
        .catch((err) => {
          if (!fieldRef.current) setError(err instanceof Error ? err.message : 'Не удалось загрузить поле');
        })
        .finally(() => setLoading(false));

      const rest = [
        listInspections(id).then(setInspections).catch(() => {}),
        getFieldSatellite(id).then(setSatellite).catch(() => {}),
        getFieldZones(id)
          .then((value) => {
            setZonesData(value);
            if (value.zones.length > 0) setSelectedZone((prev) => prev ?? value.zones[0]);
          })
          .catch(() => {}),
        getFieldWeather(id).then(setWeather).catch(() => {}),
        getFieldClassification(id).then(setClassification).catch(() => {}),
        getFieldClimateRisk(id).then(setClimateRisk).catch(() => {}),
        getFieldYieldForecast(id).then(setYieldForecast).catch(() => {}),
        getFieldOperationsRecommendation(id).then(setOperations).catch(() => {}),
      ];

      await Promise.allSettled([fieldTask, ...rest]);
    } finally {
      setRefreshing(false);
      isLoadingRef.current = false;
    }
  }, [id]);

  // Fetch zones for a specific period (peak / latest / custom date)
  const fetchZonesForPeriod = useCallback(async (date: string) => {
    if (!id) return;
    setPeriodLoading(true);
    setSelectedPeriod(date);
    try {
      const value = await getFieldZones(id, date);
      setZonesData(value);
      setSelectedZone(value.zones[0] ?? null);
    } catch {
      // keep existing data on error
    } finally {
      setPeriodLoading(false);
    }
  }, [id]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const region = useMemo(() => {
    if (!field) return undefined;
    const lats = field.boundary.map((p) => p.latitude);
    const lngs = field.boundary.map((p) => p.longitude);
    const minLat = Math.min(...lats); const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs); const maxLng = Math.max(...lngs);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: Math.max((maxLat - minLat) * 1.7, 0.014),
      longitudeDelta: Math.max((maxLng - minLng) * 1.7, 0.014),
    };
  }, [field]);

  // Must stay ABOVE the early returns below — calling a hook after a conditional
  // `return` breaks the Rules of Hooks (React #310) and blanks the screen when the
  // card first mounts in `loading` state (e.g. after creating a field).
  const askAiAboutField = useCallback((cleanQuestion?: string) => {
    if (!field) return;
    router.replace({
      pathname: '/',
      params: {
        tab: 'ai_tools',
        fieldId: field.id,
        aiPrompt: cleanQuestion || '',
      },
    });
  }, [field, router]);

  // --- Loading / Error states ---
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={styles.loadingText}>Загрузка данных поля…</Text>
      </View>
    );
  }
  if (error || !field || !region) {
    return (
      <View style={styles.center}>
        <Text style={styles.errTitle}>Ошибка загрузки</Text>
        <Text style={styles.errText}>{error ?? 'Поле не найдено'}</Text>
        <Pressable onPress={load} style={styles.retryBtn}>
          <Text style={styles.retryText}>Повторить</Text>
        </Pressable>
      </View>
    );
  }

  const latestObs = satellite?.observations?.[satellite.observations.length - 1];
  const avatar = getCropAvatar(field.cropType);

  function confirmDelete() {
    Alert.alert(
      'Удалить участок?',
      `«${field!.name}» и все его осмотры будут удалены из локальной базы.`,
      [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Удалить', style: 'destructive', onPress: () => void removeField() },
      ],
    );
  }

  async function removeField() {
    try {
      await deleteField(field!.id);
      router.replace({ pathname: '/', params: { profileId: field!.profileId } });
    } catch (e) {
      Alert.alert('Не удалось удалить', e instanceof Error ? e.message : 'Повторите попытку.');
    }
  }

  function confirmInspectionDelete(inspection: Inspection) {
    confirmDestructive(
      'Удалить запись осмотра?',
      'Заметка и прикреплённый снимок будут удалены без возможности восстановления.',
      () => void removeInspection(inspection),
    );
  }

  async function removeInspection(inspection: Inspection) {
    try {
      await deleteInspection(inspection.id, inspection.fieldId);
      setInspections((current) => {
        const next = current.filter((item) => item.id !== inspection.id);
        void saveLocalCache(CACHE_KEYS.INSPECTIONS(inspection.fieldId), next);
        return next;
      });
    } catch (nextError) {
      notify('Не удалось удалить осмотр', nextError instanceof Error ? nextError.message : 'Повторите попытку.');
    }
  }

  async function openExport(format: 'geojson' | 'csv' | 'pdf') {
    try {
      const url = await buildAuthorizedDownloadUrl(`/api/fields/${encodeURIComponent(field!.id)}/export/${format}`);
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        Alert.alert('Выгрузка недоступна', 'Устройство не может открыть этот тип файла.');
        return;
      }
      await Linking.openURL(url);
    } catch (e) {
      Alert.alert('Не удалось открыть отчёт', e instanceof Error ? e.message : 'Повторите попытку.');
    }
  }

  const ndviStatusColor = zonesData?.meanFieldNdvi != null
    ? (zonesData.meanFieldNdvi > 0.5 ? colors.success : colors.warning)
    : colors.text;

  return (
    <View style={{ flex: 1 }}>
      {refreshing && !loading && (
        <View style={styles.refreshingOverlay} pointerEvents="none">
          <View style={styles.refreshingChip}>
            <ActivityIndicator size="small" color={colors.primaryDark} />
            <Text style={styles.refreshingText}>Обновляем данные…</Text>
          </View>
        </View>
      )}
      <Screen contentStyle={styles.content}>

      {/* ── 1. OVERVIEW CARD ───────────────────────────────────── */}
      <Card style={styles.overviewCard}>
        <View style={styles.overviewHeader}>
          <View style={[styles.cropAvatar, { backgroundColor: avatar.bg }]}>
            <Text style={[styles.cropAvatarText, { color: avatar.text }]}>{avatar.short}</Text>
          </View>
          <View style={styles.overviewTitles}>
            <Text style={styles.fieldName} numberOfLines={2}>{field.name}</Text>
            <Text style={styles.fieldCrop} numberOfLines={1}>{field.cropType}</Text>
          </View>
        </View>

        <View style={styles.hairline} />

        <View style={styles.metricsRow}>
          <MetricCell value={field.areaHa.toFixed(1)} unit="га" label="Площадь" />
          <View style={styles.vertDiv} />
          <MetricCell
            value={field.perimeterKm != null ? field.perimeterKm.toFixed(1) : '—'}
            unit="км"
            label="Периметр"
          />
          <View style={styles.vertDiv} />
          <MetricCell value={String(inspections.length)} unit="" label="Осмотров" />
        </View>
      </Card>

      {/* ── AI КОНСУЛЬТАНТ ПО УЧАСТКУ ─────────────────────────── */}
      <Card style={styles.aiConsultantCard}>
        <View style={styles.aiConsultantHeader}>
          <View style={styles.aiConsultantBadge}>
            <Text style={styles.aiConsultantBadgeText}>✨ AI-Консультант</Text>
          </View>
          <Text style={styles.aiConsultantTitle}>
            Анализ участка «{field.name}»
          </Text>
          <Text style={styles.aiConsultantDesc}>
            Персональный расчёт погоды, баланса влаги и фитосанитарных рисков по координатам поля в Акмолинской области.
          </Text>
        </View>

        <View style={styles.aiQuickChipsWrap}>
          <Pressable
            style={({ pressed }) => [styles.aiQuickChip, pressed && styles.aiQuickChipPressed]}
            onPress={() => askAiAboutField(`Какой фитосанитарный прогноз и рекомендации по культуре ${field.cropType || 'растения'} на поле «${field.name}» (${field.areaHa.toFixed(1)} га)?`)}
          >
            <Text style={styles.aiQuickChipText}>🌾 Прогноз и созревание</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.aiQuickChip, pressed && styles.aiQuickChipPressed]}
            onPress={() => askAiAboutField(`Оценить водный баланс, испаряемость и окно внесения СЗР для поля «${field.name}» на 7 дней.`)}
          >
            <Text style={styles.aiQuickChipText}>💧 Влага и окно СЗР</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.aiQuickChip, pressed && styles.aiQuickChipPressed]}
            onPress={() => askAiAboutField(`Какая схема защиты от сорняков, болезней и вредителей рекомендуется для поля «${field.name}» (${field.cropType})?`)}
          >
            <Text style={styles.aiQuickChipText}>🛡️ Схема защиты</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.aiQuickChip, pressed && styles.aiQuickChipPressed]}
            onPress={() => askAiAboutField(`Составь детальный план обследования и чек-лист для полевого осмотра участка «${field.name}» (${field.cropType}, ${field.areaHa.toFixed(1)} га).`)}
          >
            <Text style={styles.aiQuickChipText}>📋 План осмотра</Text>
          </Pressable>
        </View>

        <Pressable
          style={({ pressed }) => [styles.aiOpenChatBtn, pressed && styles.aiOpenChatBtnPressed]}
          onPress={() => askAiAboutField()}
        >
          <Text style={styles.aiOpenChatBtnText}>Задать свой вопрос в AI-чате →</Text>
        </Pressable>
      </Card>

      {classification && (
        <>
          <SectionLabel title="ИСПОЛЬЗОВАНИЕ ЗЕМЛИ" right="NDVI амплитуда" />
          <Card style={styles.classCard}>
            <View style={styles.classHeader}>
              <Badge
                label={classification.label}
                variant={classification.status === 'active' ? 'success' : classification.status === 'fallow' ? 'warning' : 'neutral'}
              />
              <Text style={styles.classRule} numberOfLines={1}>
                {classification.amplitude != null ? `Δ ${classification.amplitude.toFixed(2)}` : 'мало снимков'}
              </Text>
            </View>
            <Text style={styles.classDescription}>{classification.description}</Text>
            <View style={styles.hairline} />
            <View style={styles.classMetrics}>
              <MetricCell value={classification.minNdvi != null ? classification.minNdvi.toFixed(2) : '—'} unit="" label="min NDVI" />
              <View style={styles.vertDiv} />
              <MetricCell value={classification.maxNdvi != null ? classification.maxNdvi.toFixed(2) : '—'} unit="" label="max NDVI" />
            </View>
          </Card>
        </>
      )}

      {/* ── 2. SATELLITE STATUS ────────────────────────────────── */}
      <SectionLabel
        title="СПУТНИКОВЫЙ АНАЛИЗ"
        right={satellite?.status === 'ready' ? 'Copernicus · 10-дневные периоды' : undefined}
      />
      <Card style={styles.satCard}>
        <View style={styles.satMissionRow}>
          <Text style={styles.satMission} numberOfLines={1}>Sentinel-2 L2A · 10 м/пикс</Text>
          <Badge
            label={satellite?.status === 'ready' ? 'Готово' : 'Ожидание'}
            variant={satellite?.status === 'ready' ? 'success' : 'neutral'}
          />
        </View>

        <View style={styles.hairline} />

        {satellite?.status === 'ready' && latestObs ? (
          <>
            <View style={styles.satStatsRow}>
              <View style={styles.satStatCell}>
                <Text style={[styles.satStatVal, { color: ndviStatusColor }]}>{(latestObs.ndviMedian ?? latestObs.ndviMean).toFixed(2)}</Text>
                <Text style={styles.satStatLabel}>NDVI поля</Text>
              </View>
              <View style={styles.vertDiv} />
              <View style={styles.satStatCell}>
                <Text style={styles.satStatVal}>{latestObs.ndmiMean != null ? latestObs.ndmiMean.toFixed(2) : '—'}</Text>
                <Text style={styles.satStatLabel}>NDMI поля</Text>
              </View>
              <View style={styles.vertDiv} />
              <View style={styles.satStatCell}>
                <Text style={styles.satStatVal}>{measurement(latestObs.cloudCoveragePercent, '%', 0)}</Text>
                <Text style={styles.satStatLabel}>Облачность</Text>
                {latestObs.cloudStatus ? (
                  <Text style={styles.satObsCloud}>{latestObs.cloudStatus}</Text>
                ) : null}
              </View>
            </View>
            <View style={styles.hairline} />
            <View style={styles.satObsRow}>
              <Text style={styles.satObsText}>
                Период {latestObs.date} — {latestObs.periodEnd ?? '—'}
                {latestObs.clearPixelPercent != null ? ` · пригодно ${latestObs.clearPixelPercent.toFixed(0)}% доступных пикселей` : ''}
              </Text>
              {latestObs.reliability ? (
                <View style={[styles.relBadge, { backgroundColor: riskLevelMeta(latestObs.reliability === 'high' ? 'low' : latestObs.reliability === 'medium' ? 'moderate' : 'high').bg }]}>
                  <Text style={[styles.relBadgeText, { color: riskLevelMeta(latestObs.reliability === 'high' ? 'low' : latestObs.reliability === 'medium' ? 'moderate' : 'high').color }]}>
                    {latestObs.reliability === 'high' ? 'Хорошее покрытие' : latestObs.reliability === 'medium' ? 'Частичное покрытие' : 'Качество неизвестно'}
                  </Text>
                </View>
              ) : null}
            </View>
            {satellite.stale && <Text style={styles.pendingText}>Сохранённые данные: обновление не удалось.</Text>}
            {latestObs.anomalyDetected && latestObs.anomalyFactor && (
              <View style={styles.anomalyBox}>
                <Text style={styles.anomalyText}>{latestObs.anomalyFactor}</Text>
              </View>
            )}
          </>
        ) : (
          <View style={styles.pendingBox}>
            <Text style={styles.pendingText}>
              {satellite?.message ?? 'Обработанный снимок Sentinel-2 для этого поля пока недоступен.'}
            </Text>
          </View>
        )}
      </Card>

      {satellite?.status === 'ready' && satellite.observations.length > 0 && (
        <>
          <SectionLabel
            title="СЕЗОННАЯ ДИНАМИКА"
            right={`${satellite.observationCount ?? satellite.observations.length} наблюдений`}
          />
          <IndexHistory observations={satellite.observations} />
          <Card style={styles.dataSourceCard}>
            <InfoRow
              label="Период анализа"
              value={`${satellite.periodStart ?? satellite.observations[0].date} — ${satellite.periodEnd ?? latestObs?.date}`}
            />
            <View style={styles.hairline} />
            <InfoRow label="Исходные каналы" value="NDVI: 10 м · SWIR для NDMI: 20 м" />
            <View style={styles.hairline} />
            <InfoRow label="Маска облаков" value={satellite.cloudMaskingMethod} />
            <View style={styles.hairline} />
            <InfoRow label="Получено с сервера" value={new Date(satellite.updatedAt).toLocaleString('ru-RU')} />
            <InfoRow label="Валидных пикселей" value={latestObs?.validPixelCount?.toString() ?? '—'} />
            <InfoRow label="Разброс NDVI (p90–p10)" value={measurement(latestObs?.ndviSpread, '', 3)} />
          </Card>
        </>
      )}

      {/* ── 2.1 YIELD FORECAST ────────────────────────────────── */}
      <SectionLabel
        title="ПРОГНОЗ УРОЖАЙНОСТИ"
        right={yieldForecast?.status === 'ready' ? `${yieldForecast.seasonYear} · модель поля` : undefined}
      />
      <Card style={styles.yieldCard}>
        {yieldForecast?.status === 'ready' && yieldForecast.forecastTPerHa != null && yieldForecast.interval80 ? (
          <>
            <View style={styles.yieldHero}>
              <View style={styles.yieldMain}>
                <View style={styles.yieldValueRow}>
                  <Text style={styles.yieldValue}>{yieldForecast.forecastTPerHa.toFixed(2)}</Text>
                  <Text style={styles.yieldUnit}>т/га</Text>
                </View>
                <Text style={styles.yieldCaption}>ожидаемая урожайность</Text>
              </View>
              <View style={styles.yieldInterval}>
                <Text style={styles.yieldIntervalValue}>
                  {yieldForecast.interval80.low.toFixed(2)}–{yieldForecast.interval80.high.toFixed(2)}
                </Text>
                <Text style={styles.yieldIntervalLabel}>80% прогнозный интервал</Text>
              </View>
            </View>
            <View style={styles.hairline} />
            <View style={styles.yieldMetaRow}>
              <Text style={styles.yieldMeta}>История: {yieldForecast.historyCount} сез.</Text>
              <Text style={styles.yieldMeta}>
                MAE проверки: {measurement(yieldForecast.validationMaeTPerHa, ' т/га', 2)}
              </Text>
            </View>
            <View style={styles.hairline} />
            <View style={styles.factorList}>
              {yieldForecast.factors.slice(0, 4).map((factor) => {
                const factorColor = factor.direction === 'positive'
                  ? '#166534'
                  : factor.direction === 'negative'
                    ? '#B91C1C'
                    : colors.textSecondary;
                return (
                  <View key={factor.id} style={styles.factorRow}>
                    <View style={styles.factorText}>
                      <Text style={styles.factorLabel}>{factor.label}</Text>
                      <Text style={styles.factorDetail}>{factor.detail}</Text>
                    </View>
                    <Text style={[styles.factorValue, { color: factorColor }]}>
                      {factor.contributionTPerHa > 0 ? '+' : ''}{factor.contributionTPerHa.toFixed(2)} т/га
                    </Text>
                  </View>
                );
              })}
            </View>
            <Text style={styles.yieldDisclaimer}>
              {yieldForecast.stale ? 'Показан сохранённый прогноз: обновление недоступно. ' : ''}
              Вклад модели не доказывает причинность. Диапазон рассчитан по ошибкам исключённых сезонов.
            </Text>
          </>
        ) : (
          <View style={styles.yieldEmpty}>
            <Text style={styles.yieldEmptyTitle}>
              {yieldForecast?.status === 'unavailable' ? 'Прогноз временно недоступен' : 'Нужна история урожаев'}
            </Text>
            <Text style={styles.yieldEmptyText}>
              {yieldForecast?.message ?? 'Добавьте фактическую урожайность прошлых сезонов для калибровки модели этого поля.'}
            </Text>
            {yieldForecast?.missingData.map((item) => (
              <Text key={item} style={styles.yieldMissing}>• {item}</Text>
            ))}
          </View>
        )}
        <View style={styles.hairline} />
        <ActionRow
          title="История урожайности и источники"
          onPress={() => router.push({ pathname: '/field/[id]/yield-history', params: { id: field.id } })}
        />
      </Card>

      {/* ── 2.3 FIELD OPERATION WINDOWS ──────────────────────── */}
      <SectionLabel
        title="СРОКИ ПОЛЕВЫХ РАБОТ"
        right={operations?.horizonStart && operations.horizonEnd
          ? `${shortDay(operations.horizonStart)}–${shortDay(operations.horizonEnd)}`
          : undefined}
      />
      <Card style={styles.operationsCard}>
        {operations?.status === 'ready' ? (
          <>
            <View style={styles.fieldStateRow}>
              <View style={styles.fieldStateText}>
                <Text style={styles.fieldStateTitle}>{operations.fieldState.label}</Text>
                <Text style={styles.fieldStateDetail}>{operations.fieldState.message}</Text>
              </View>
              {operations.fieldState.declineFromPeak != null ? (
                <View style={styles.ndviDeltaBox}>
                  <Text style={styles.ndviDeltaValue}>−{operations.fieldState.declineFromPeak.toFixed(2)}</Text>
                  <Text style={styles.ndviDeltaLabel}>от пика NDVI</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.hairline} />
            {operations.operations.map((operation, index) => {
              const best = operation.windows[0];
              const badgeLabel = operation.status === 'recommended'
                ? 'Оптимальное окно'
                : operation.status === 'watch'
                  ? 'Наблюдать'
                  : operation.status === 'verify_field'
                    ? 'Проверить поле'
                    : operation.status === 'no_window'
                      ? 'Окна нет'
                      : 'Вне сезона';
              const badgeVariant = operation.status === 'recommended'
                ? 'success'
                : operation.status === 'watch' || operation.status === 'verify_field'
                  ? 'warning'
                  : 'neutral';
              return (
                <View key={operation.type}>
                  {index > 0 ? <View style={styles.hairline} /> : null}
                  <View style={styles.operationBlock}>
                    <View style={styles.operationHeader}>
                      <View style={styles.operationHeading}>
                        <Text style={styles.operationTitle}>{operation.title}</Text>
                        <Text style={styles.operationCalendar}>сезонный ориентир {operation.calendar}</Text>
                      </View>
                      <Badge label={badgeLabel} variant={badgeVariant} />
                    </View>
                    {best ? (
                      <>
                        <View style={styles.bestWindowRow}>
                          <View>
                            <Text style={styles.bestWindowDate}>{shortDay(best.start)}–{shortDay(best.end)}</Text>
                            <Text style={styles.bestWindowLabel}>лучшее доступное окно</Text>
                          </View>
                          <View style={styles.windowScoreBox}>
                            <Text style={styles.windowScore}>{best.score}</Text>
                            <Text style={styles.windowScoreLabel}>из 100</Text>
                          </View>
                        </View>
                        <View style={styles.operationMetrics}>
                          <Text style={styles.operationMetric}>{best.metrics.precipSum.toFixed(1)} мм осадков</Text>
                          <Text style={styles.operationMetric}>ветер до {best.metrics.maxWind.toFixed(1)} м/с</Text>
                          {operation.type === 'sowing' && best.metrics.soilTemperature != null ? (
                            <Text style={styles.operationMetric}>почва {best.metrics.soilTemperature.toFixed(1)}°C</Text>
                          ) : null}
                        </View>
                        <Text style={styles.operationFactors}>{best.factors.join(' · ')}</Text>
                        {best.risks.length > 0 ? <Text style={styles.operationRisks}>{best.risks.join(' · ')}</Text> : null}
                        {operation.windows.length > 1 ? (
                          <Text style={styles.alternativeWindows}>
                            Запасные окна: {operation.windows.slice(1).map((item) => `${shortDay(item.start)}–${shortDay(item.end)}`).join(', ')}
                          </Text>
                        ) : null}
                      </>
                    ) : (
                      <Text style={styles.operationSummary}>{operation.summary}</Text>
                    )}
                  </View>
                </View>
              );
            })}
            <View style={styles.hairline} />
            <Text style={styles.operationsDisclaimer}>
              {operations.stale ? 'Показана сохранённая рекомендация. ' : ''}{operations.message}
            </Text>
          </>
        ) : (
          <View style={styles.yieldEmpty}>
            <Text style={styles.yieldEmptyTitle}>Сроки пока не рассчитаны</Text>
            <Text style={styles.yieldEmptyText}>{operations?.message ?? 'Получаем прогноз погоды и состояние поля.'}</Text>
          </View>
        )}
      </Card>

      {/* ── 3. WEATHER ─────────────────────────────────────────── */}
      {weather && (
        <>
          <SectionLabel title="АГРОМЕТЕОРОЛОГИЯ" right={weather.source} />
          <Card style={styles.weatherCard}>
            <Text style={styles.riskSource}>{weather.message ?? `Модельные условия на ${weather.observedAt ?? '—'}. Прогноз ${weather.forecastStart ?? '—'} — ${weather.forecastEnd ?? '—'}.`}</Text>
            <View style={styles.weatherGrid}>
              <WeatherCell value={measurement(weather.current.temperature, '°C')} label="Температура" />
              <WeatherCell value={measurement(weather.current.humidity, '%', 0)} label="Влажность воздуха" />
              <WeatherCell value={measurement(weather.current.windSpeed, ' м/с')} label="Ветер" />
              <WeatherCell value={measurement(weather.forecast7d.precipSum, ' мм')} label="Осадки: прогноз 7 дней" />
              <WeatherCell value={measurement(weather.forecast7d.minTemp, '°C')} label="Минимум по прогнозу" />
              <WeatherCell value={measurement(weather.forecast7d.waterBalance, ' мм')} label="Прогноз: осадки − ET₀" />
            </View>

            {weather.forecast7d.evapotranspiration != null && (
              <>
                <View style={styles.hairline} />
                <View style={styles.etRow}>
                  <Text style={styles.etLabel}>Прогноз ET₀ на 7 дней</Text>
                  <Text style={styles.etValue}>{weather.forecast7d.evapotranspiration.toFixed(1)} мм</Text>
                </View>
              </>
            )}

            {weather.forecast7d.gddSum != null && (
              <>
                <View style={styles.hairline} />
                <View style={styles.etRow}>
                  <Text style={styles.etLabel}>Прогноз GDD за 7 дней, база 5°C</Text>
                  <Text style={styles.etValue}>{weather.forecast7d.gddSum.toFixed(0)}°</Text>
                </View>
              </>
            )}

            {weather.alerts.length > 0 && (
              <View style={styles.alertBox}>
                <Text style={styles.alertTitle}>{weather.alerts[0].title}</Text>
                <Text style={styles.alertDesc}>{weather.alerts[0].description}</Text>
              </View>
            )}
          </Card>
        </>
      )}

      {/* ── 3b. КЛИМАТИЧЕСКИЙ РИСК ПО ДЕКАДАМ (задача 2.2) ────────── */}
      {climateRisk && climateRisk.available && climateRisk.decades.length > 0 && (
        <>
          <SectionLabel title="ИНДЕКС ПО ДЕКАДАМ" right="шкала правил 0–100" />
          <Card style={styles.weatherCard}>
            <Text style={styles.riskSummary}>{climateRisk.summary}</Text>

            {climateRisk.alerts.map((a, i) => (
              <View
                key={`${a.type}-${i}`}
                style={[styles.alertBox, a.level === 'critical' && styles.alertBoxCritical]}
              >
                <Text style={styles.alertTitle}>
                  {a.level === 'critical' ? '⛔ ' : '⚠️ '}{a.title}
                </Text>
                <Text style={styles.alertDesc}>{a.description}</Text>
              </View>
            ))}

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.riskScroll}
            >
              {climateRisk.decades.map((d, i) => {
                const meta = riskLevelMeta(d.overall_level);
                return (
                  <View key={i} style={[styles.riskCard, d.is_past && styles.riskCardPast]}>
                    <View style={styles.riskCardHeader}>
                      <Text style={styles.riskCardLabel} numberOfLines={1}>{d.label}</Text>
                      {d.is_past ? <Text style={styles.riskPastTag}>прошлый период</Text> : null}
                    </View>
                    <Text style={styles.riskCardPeriod}>{d.period}</Text>

                    <View style={[styles.riskBadge, { backgroundColor: meta.bg }]}>
                      <Text style={[styles.riskBadgeNum, { color: meta.color }]}>{d.overall_index}</Text>
                      <Text style={[styles.riskBadgeLabel, { color: meta.color }]}>{meta.label} индекс</Text>
                    </View>

                    <RiskMiniBar label="🏜 Засуха" value={d.drought_index} color="#CA8A04" />
                    <RiskMiniBar label="🌬 Суховей" value={d.sukhovey_index} color="#EA580C" />
                    <RiskMiniBar label="❄️ Снег/мороз" value={d.early_snow_index} color="#2563EB" />

                    <Text style={styles.riskFactors} numberOfLines={3}>
                      {d.factors.join(' · ')}
                    </Text>
                  </View>
                );
              })}
            </ScrollView>

            <Text style={styles.riskSource}>Источник: {climateRisk.source}. Индекс 0–100 — пороговая оценка, не вероятность события.</Text>
          </Card>
        </>
      )}

      {/* ── 4. MAP ─────────────────────────────────────────────── */}
      <SectionLabel title="КАРТА УЧАСТКА" />

      {/* Post-harvest banner */}
      {zonesData?.isPostHarvest && zonesData.postHarvestNotice && (
        <Card style={styles.postHarvestCard}>
          <Text style={styles.postHarvestText}>{zonesData.postHarvestNotice}</Text>
        </Card>
      )}

      {/* Period selector for NDVI grid */}
      {zonesData?.availablePeriods && zonesData.availablePeriods.length > 1 && (
        <>
          <Text style={styles.periodSelectorLabel}>ПЕРИОД АНАЛИЗА СЕТКИ</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.periodSelectorRow}
          >
            {zonesData.availablePeriods.map((p) => {
              const isActive = selectedPeriod
                ? p.date === selectedPeriod
                : p.isLatest;
              return (
                <Pressable
                  key={p.date}
                  onPress={() => void fetchZonesForPeriod(p.isPeak ? 'peak' : p.isLatest ? 'latest' : p.date)}
                  style={({ pressed }) => [
                    styles.periodChip,
                    isActive && styles.periodChipActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.periodChipText, isActive && styles.periodChipTextActive]}>
                    {p.isPeak ? '🌾 ' : p.isLatest ? '📡 ' : ''}{p.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          {periodLoading && (
            <View style={styles.periodLoadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.periodLoadingText}>Загрузка сетки…</Text>
            </View>
          )}
        </>
      )}

      {/* Growth phase badge */}
      {zonesData?.growthPhase && (
        <Text style={styles.growthPhaseLabel}>{zonesData.growthPhase}</Text>
      )}

      {zonesData?.status === 'ready' && (
        <Text style={styles.pendingText}>
          {zonesData.stale ? 'Сохранённая сетка. ' : ''}
          Период {zonesData.observationDate ?? '—'} — {zonesData.periodEnd ?? '—'} · проверено {measurement(zonesData.coveragePercent, '%', 0)} площади. Устойчивость зон требует повторных наблюдений.
        </Text>
      )}
      <View style={styles.segmentedWrap}>
        <SegTab label="Зоны риска" active={mapMode === 'zones'} onPress={() => setMapMode('zones')} />
        <SegTab label="Сетка NDVI" active={mapMode === 'satellite'} onPress={() => setMapMode('satellite')} />
        <SegTab label="Контур" active={mapMode === 'boundary'} onPress={() => setMapMode('boundary')} />
      </View>

      <View style={styles.mapFrame}>
        <MapView style={styles.map} initialRegion={region} mapType={mapType}>
            <Polygon
              coordinates={field.boundary}
              fillColor={mapMode === 'boundary' ? 'rgba(30,126,52,0.10)' : 'rgba(30,126,52,0.04)'}
              strokeColor={colors.primary}
              strokeWidth={2}
            />
            {/* Реальная NDVI-тепловая карта поля из посотовой выборки Sentinel-2 */}
            {mapMode === 'satellite' && zonesData?.ndviGrid.map((cell) => (
              <Polygon
                key={cell.id}
                coordinates={cell.boundary}
                fillColor={cell.color}
                strokeColor="rgba(255,255,255,0.35)"
                strokeWidth={0.5}
              />
            ))}
            {mapMode === 'zones' && zonesData?.zones.map((zone) => (
              <Polygon
                key={zone.id}
                coordinates={zone.boundary}
                fillColor={zone.fillColor}
                strokeColor={selectedZone?.id === zone.id ? '#1C1C1E' : zone.strokeColor}
                strokeWidth={selectedZone?.id === zone.id ? 3 : 2}
                tappable
                onPress={() => setSelectedZone(zone)}
              />
            ))}
            {mapMode === 'zones' && selectedZone && (
              <Marker coordinate={selectedZone.centroid} title={selectedZone.title} description={`${selectedZone.areaHa.toFixed(1)} га`} />
            )}
        </MapView>

        <View style={styles.mapTag}>
          <Text style={styles.mapTagText} numberOfLines={1}>
            {mapMode === 'zones'
              ? 'Sentinel-2 · кластеры аномалий'
              : mapMode === 'satellite'
              ? (zonesData?.ndviGrid.length ? `Сетка NDVI · ${zonesData.ndviGrid.length} ячеек` : 'Ожидание данных Sentinel-2')
              : 'Сохранённый контур участка'}
          </Text>
        </View>

        {mapMode === 'satellite' && zonesData?.ndviRange && zonesData.ndviGrid.length > 0 && (
          <View style={styles.ndviLegend}>
            <Text style={styles.ndviLegendVal}>{zonesData.ndviRange.min.toFixed(2)}</Text>
            <View style={styles.ndviLegendBar}>
              {NDVI_LEGEND_COLORS.map((c, i) => (
                <View key={i} style={[styles.ndviLegendSeg, { backgroundColor: c }]} />
              ))}
            </View>
            <Text style={styles.ndviLegendVal}>{zonesData.ndviRange.max.toFixed(2)}</Text>
          </View>
        )}

        {Platform.OS !== 'web' && (
          <Pressable
            onPress={() => setMapType((current) => (current === 'standard' ? 'satellite' : 'standard'))}
            style={styles.mapTypeToggle}
          >
            <Text style={styles.mapTypeToggleText}>{mapType === 'standard' ? 'Спутник' : 'Схема'}</Text>
          </Pressable>
        )}
      </View>

      {/* ── 5. RISK ZONES ──────────────────────────────────────── */}
      {zonesData && zonesData.zones.length > 0 ? (
        <>
          <SectionLabel
            title={`ОЧАГИ РИСКА — ${zonesData.zonesCount}`}
            right={`${zonesData.totalSuspectAreaHa.toFixed(1)} га / ${zonesData.totalFieldAreaHa.toFixed(0)} га`}
          />

          <View style={styles.zonePicker}>
            {zonesData.zones.map((zone) => (
              <ZonePill
                key={zone.id}
                zone={zone}
                active={selectedZone?.id === zone.id}
                onPress={() => setSelectedZone(zone)}
              />
            ))}
          </View>

          {selectedZone && (
            <Card style={styles.zoneCard}>
              {/* Zone metric row */}
              <View style={styles.zoneMetrics}>
                <View style={styles.zoneMetricCell}>
                  <Text style={[styles.zoneMetricVal, { color: selectedZone.severity === 'critical' ? colors.danger : colors.warning }]}>
                    {selectedZone.areaHa.toFixed(1)} га
                  </Text>
                  <Text style={styles.zoneMetricLabel}>{selectedZone.percentOfField.toFixed(1)}% поля</Text>
                </View>
                <View style={styles.vertDiv} />
                <View style={styles.zoneMetricCell}>
                  <Text style={styles.zoneMetricVal}>{selectedZone.ndviDeficit.toFixed(2)}</Text>
                  <Text style={styles.zoneMetricLabel}>Δ NDVI</Text>
                </View>
                <View style={styles.vertDiv} />
                <View style={styles.zoneMetricCell}>
                  <Text style={styles.zoneMetricVal}>{selectedZone.ndmiDeficit?.toFixed(2) ?? '—'}</Text>
                  <Text style={styles.zoneMetricLabel}>Δ NDMI влага</Text>
                </View>
              </View>

              <View style={styles.hairline} />

              {/* Factor & Recommendation */}
              <View style={styles.zoneInfoBlock}>
                <Text style={styles.zoneInfoTitle}>Основной фактор</Text>
                <Text style={styles.zoneInfoText}>{selectedZone.mainFactor}</Text>
              </View>

              <View style={styles.hairline} />

              <View style={styles.zoneInfoBlock}>
                <Text style={styles.zoneInfoTitle}>Рекомендация</Text>
                <Text style={styles.zoneInfoText}>{selectedZone.recommendation}</Text>
              </View>

              <View style={styles.hairline} />

              <View style={styles.zonePersistenceRow}>
                <Text style={styles.zonePersistenceText}>{selectedZone.persistenceStatus}</Text>
              </View>

              {/* Dispatch button */}
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: '/field/[id]/new-inspection',
                    params: {
                      id: field.id,
                      targetLat: String(selectedZone.centroid.latitude),
                      targetLng: String(selectedZone.centroid.longitude),
                      zoneTitle: `${selectedZone.title} (${selectedZone.areaHa.toFixed(1)} га)`,
                    },
                  })
                }
                style={({ pressed }) => [styles.dispatchBtn, pressed && styles.pressed]}
              >
                <Text style={styles.dispatchBtnText}>Выехать на осмотр этого очага →</Text>
              </Pressable>
            </Card>
          )}

          {/* Scouting savings */}
          {zonesData.benchmark && (
            <Card style={styles.savingsCard}>
              <InfoRow
                label="Целевой скаутинг"
                value={`${zonesData.benchmark.economicScouting.targetInspectionHa.toFixed(1)} га из ${zonesData.benchmark.economicScouting.fieldAreaHa.toFixed(0)} га`}
              />
              <View style={styles.hairline} />
              <InfoRow
                label="Проверено площади"
                value={measurement(zonesData.coveragePercent, '%', 0)}
              />
              <View style={styles.hairline} />
              <InfoRow
                label="Источник данных"
                value={zonesData.dataSource ?? zonesData.satelliteMission}
              />
              <InfoRow label="Период сетки" value={`${zonesData.observationDate ?? '—'} — ${zonesData.periodEnd ?? '—'}`} />
            </Card>
          )}
        </>
      ) : (
        <>
          <SectionLabel title="ОЧАГИ РИСКА" />
          <Card style={styles.pendingZonesCard}>
            <Text style={styles.pendingZonesTitle}>Геометрия очагов недоступна</Text>
            <Text style={styles.pendingText}>
              {zonesData?.message ?? 'Требуется попиксельная обработка снимка Sentinel-2.'}
            </Text>
          </Card>
        </>
      )}

      {/* ── 6. ACTIONS ─────────────────────────────────────────── */}
      <SectionLabel title="ДЕЙСТВИЯ" />
      <Card style={styles.actionsCard}>
        <ActionRow
          title="+ Произвольный осмотр поля"
          onPress={() => router.push({ pathname: '/field/[id]/new-inspection', params: { id: field.id } })}
        />
        <View style={styles.hairline} />
        <ActionRow
          title="Редактировать контур и метраж"
          onPress={() => router.push({ pathname: '/field/new', params: { fieldId: field.id, profileId: field.profileId } })}
        />
        <View style={styles.hairline} />
        <ActionRow
          title="История фактической урожайности"
          onPress={() => router.push({ pathname: '/field/[id]/yield-history', params: { id: field.id } })}
        />
        <View style={styles.hairline} />
        <ActionRow title="Скачать GeoJSON для QGIS" onPress={() => void openExport('geojson')} />
        <View style={styles.hairline} />
        <ActionRow
          title="Полевой аналитический отчёт (PDF)"
          subtitle="Контур, доступные данные Sentinel-2, погода и прогноз"
          highlight
          onPress={() => void openExport('pdf')}
        />
        <View style={styles.hairline} />
        <ActionRow title="Удалить участок" destructive onPress={confirmDelete} />
      </Card>

      {/* ── 7. INSPECTIONS ─────────────────────────────────────── */}
      <SectionLabel title={`ЖУРНАЛ ОСМОТРОВ (${inspections.length})`} />

      {inspections.length === 0 ? (
        <EmptyState
          title="Осмотры отсутствуют"
          text="Нажмите «Выехать на осмотр» выше или используйте произвольный осмотр."
        />
      ) : (
        <Card style={styles.inspGroup}>
          {inspections.map((insp, idx) => (
            <View key={insp.id}>
              <View style={styles.inspRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Открыть осмотр от ${formatDate(insp.createdAt)}`}
                  onPress={() => {
                    void saveLocalCache(CACHE_KEYS.INSPECTION(insp.id), insp);
                    router.push({ pathname: '/inspection/[id]', params: { id: insp.id } });
                  }}
                  style={({ pressed }) => [styles.inspOpen, pressed && styles.inspRowPressed]}
                >
                  {insp.photoUrl ? (
                    <Image source={{ uri: insp.photoUrl }} style={styles.thumb} />
                  ) : (
                    <View style={styles.thumbPlaceholder}>
                      <Text style={styles.thumbPlaceholderText}>АКТ</Text>
                    </View>
                  )}
                  <View style={styles.inspMain}>
                    <View style={styles.inspTopRow}>
                      <Text style={styles.inspDate}>{formatDate(insp.createdAt)}</Text>
                      {insp.status === 'pending' ? (
                        <Badge label="Офлайн-очередь" variant="warning" />
                      ) : (
                        <Badge label="Сохранено" variant="success" />
                      )}
                    </View>
                    <Text numberOfLines={2} style={styles.inspNote}>
                      {insp.note || 'Без текстового описания'}
                    </Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Удалить осмотр от ${formatDate(insp.createdAt)}`}
                  onPress={() => confirmInspectionDelete(insp)}
                  style={({ pressed }) => [styles.inspDeleteButton, pressed && styles.inspDeletePressed]}
                >
                  <Text style={styles.inspDeleteText}>Удалить</Text>
                </Pressable>
              </View>
              {idx < inspections.length - 1 && <View style={styles.inspDivider} />}
            </View>
          ))}
        </Card>
      )}
      </Screen>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCropAvatar(cropType: string) {
  const t = cropType.toLowerCase();
  if (t.includes('пшениц')) return { short: 'ПШ', bg: colors.cropWheatBg, text: colors.cropWheatText };
  if (t.includes('рапс')) return { short: 'РП', bg: colors.cropRapeseedBg, text: colors.cropRapeseedText };
  return { short: 'КР', bg: colors.cropPotatoBg, text: colors.cropPotatoText };
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  // Layout
  content: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 36,
    gap: 10,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: 24,
    gap: 8,
  },
  loadingText: { fontFamily: fontFamilies.medium, fontSize: 13, color: colors.textSecondary },
  refreshingOverlay: {
    position: 'absolute',
    top: 8,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 20,
  },
  refreshingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 4,
  },
  refreshingText: { fontFamily: fontFamilies.medium, fontSize: 12, color: colors.primaryDark },
  errTitle: { fontFamily: fontFamilies.semiBold, fontSize: 15, color: colors.danger },
  errText: { fontFamily: fontFamilies.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, marginTop: 6 },
  retryText: { fontFamily: fontFamilies.semiBold, fontSize: 13, color: '#FFF' },

  // Common
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  vertDiv: { width: StyleSheet.hairlineWidth, backgroundColor: colors.border, alignSelf: 'stretch' },
  pressed: { opacity: 0.8 },

  // Overview card
  overviewCard: { padding: 14, gap: 0 },
  overviewHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 12 },
  cropAvatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  cropAvatarText: { fontFamily: fontFamilies.bold, fontSize: 15 },
  overviewTitles: { flex: 1, minWidth: 0, gap: 3 },
  fieldName: { fontFamily: fontFamilies.bold, fontSize: 17, color: colors.text },
  fieldCrop: { fontFamily: fontFamilies.regular, fontSize: 13, color: colors.textSecondary },
  metricsRow: { flexDirection: 'row', alignItems: 'center' },

  // AI Consultant card
  aiConsultantCard: {
    padding: 14,
    gap: 10,
    backgroundColor: '#F7FCF9',
    borderColor: '#CDEBD9',
    borderWidth: 1,
  },
  aiConsultantHeader: {
    gap: 4,
  },
  aiConsultantBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#E2F6EB',
    marginBottom: 2,
  },
  aiConsultantBadgeText: {
    fontFamily: fontFamilies.bold,
    fontSize: 11,
    color: '#0D7D4D',
  },
  aiConsultantTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 15,
    color: colors.text,
  },
  aiConsultantDesc: {
    fontFamily: fontFamilies.regular,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  aiQuickChipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  aiQuickChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#BFE7CF',
  },
  aiQuickChipPressed: {
    backgroundColor: '#E8F7EE',
  },
  aiQuickChipText: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: '#165B37',
  },
  aiOpenChatBtn: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingVertical: 4,
  },
  aiOpenChatBtnPressed: {
    opacity: 0.6,
  },
  aiOpenChatBtnText: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 13,
    color: '#0D7D4D',
  },

  // Classification card
  classCard: { padding: 0, gap: 0 },
  classHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  classRule: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: colors.textSecondary },
  classDescription: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  classMetrics: { flexDirection: 'row', alignItems: 'center' },

  // Satellite card
  satCard: { padding: 0, gap: 0 },
  satMissionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  satMission: { flex: 1, minWidth: 0, fontFamily: fontFamilies.medium, fontSize: 12, color: colors.textSecondary },
  satStatsRow: { flexDirection: 'row', alignItems: 'center' },
  satStatCell: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  satStatVal: { fontFamily: fontFamilies.bold, fontSize: 18, color: colors.text },
  satStatLabel: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.muted, marginTop: 3 },
  satObsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 8,
  },
  satObsText: { fontFamily: fontFamilies.medium, fontSize: 12, color: colors.textSecondary, flex: 1 },
  satObsCloud: { fontFamily: fontFamilies.medium, fontSize: 12, color: colors.muted },
  relBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  relBadgeText: { fontFamily: fontFamilies.semiBold, fontSize: 11 },
  anomalyBox: {
    margin: 10,
    marginTop: 0,
    backgroundColor: colors.warningSoft,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#F59E0B',
  },
  anomalyText: { fontFamily: fontFamilies.medium, fontSize: 12, color: '#78350F', lineHeight: 17 },
  pendingBox: { paddingHorizontal: 14, paddingVertical: 14 },
  pendingText: { fontFamily: fontFamilies.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  pendingZonesCard: { padding: 14, gap: 6 },
  pendingZonesTitle: { fontFamily: fontFamilies.semiBold, fontSize: 14, color: colors.text },
  dataSourceCard: { paddingHorizontal: 14, paddingVertical: 0 },

  // Yield forecast
  yieldCard: { padding: 0, gap: 0, overflow: 'hidden' },
  yieldHero: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
  },
  yieldMain: { flex: 1.05, justifyContent: 'center' },
  yieldValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  yieldValue: { fontFamily: fontFamilies.bold, fontSize: 30, color: colors.primaryDark },
  yieldUnit: { fontFamily: fontFamilies.semiBold, fontSize: 13, color: colors.textSecondary },
  yieldCaption: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.muted, marginTop: 2 },
  yieldInterval: {
    flex: 1,
    justifyContent: 'center',
    paddingLeft: 12,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border,
  },
  yieldIntervalValue: { fontFamily: fontFamilies.bold, fontSize: 16, color: colors.text },
  yieldIntervalLabel: { fontFamily: fontFamilies.medium, fontSize: 10.5, lineHeight: 14, color: colors.muted, marginTop: 3 },
  yieldMetaRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 9, gap: 8 },
  yieldMeta: { fontFamily: fontFamilies.medium, fontSize: 11.5, color: colors.textSecondary },
  factorList: { paddingHorizontal: 14, paddingVertical: 4 },
  factorRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: 10 },
  factorText: { flex: 1, minWidth: 0 },
  factorLabel: { fontFamily: fontFamilies.semiBold, fontSize: 12.5, color: colors.text },
  factorDetail: { fontFamily: fontFamilies.regular, fontSize: 10.5, color: colors.muted, marginTop: 1 },
  factorValue: { fontFamily: fontFamilies.bold, fontSize: 12.5, textAlign: 'right' },
  yieldDisclaimer: {
    fontFamily: fontFamilies.regular,
    fontSize: 10.5,
    lineHeight: 15,
    color: colors.muted,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  yieldEmpty: { paddingHorizontal: 14, paddingVertical: 14, gap: 5 },
  yieldEmptyTitle: { fontFamily: fontFamilies.semiBold, fontSize: 14, color: colors.text },
  yieldEmptyText: { fontFamily: fontFamilies.regular, fontSize: 12.5, lineHeight: 18, color: colors.textSecondary },
  yieldMissing: { fontFamily: fontFamilies.medium, fontSize: 11.5, lineHeight: 16, color: colors.muted },

  // Sowing and harvest windows
  operationsCard: { padding: 0, gap: 0, overflow: 'hidden' },
  fieldStateRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  fieldStateText: { flex: 1, minWidth: 0, gap: 3 },
  fieldStateTitle: { fontFamily: fontFamilies.semiBold, fontSize: 13.5, color: colors.text },
  fieldStateDetail: { fontFamily: fontFamilies.regular, fontSize: 11.5, lineHeight: 16, color: colors.textSecondary },
  ndviDeltaBox: { minWidth: 66, alignItems: 'flex-end' },
  ndviDeltaValue: { fontFamily: fontFamilies.bold, fontSize: 18, color: colors.primaryDark },
  ndviDeltaLabel: { fontFamily: fontFamilies.medium, fontSize: 9.5, color: colors.muted },
  operationBlock: { paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  operationHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  operationHeading: { flex: 1, minWidth: 0, gap: 2 },
  operationTitle: { fontFamily: fontFamilies.bold, fontSize: 14, color: colors.text },
  operationCalendar: { fontFamily: fontFamilies.regular, fontSize: 10.5, color: colors.muted },
  bestWindowRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  bestWindowDate: { fontFamily: fontFamilies.bold, fontSize: 18, color: colors.primaryDark },
  bestWindowLabel: { fontFamily: fontFamilies.medium, fontSize: 10.5, color: colors.muted, marginTop: 2 },
  windowScoreBox: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  windowScore: { fontFamily: fontFamilies.bold, fontSize: 18, color: colors.text },
  windowScoreLabel: { fontFamily: fontFamilies.medium, fontSize: 10, color: colors.muted },
  operationMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  operationMetric: {
    fontFamily: fontFamilies.medium,
    fontSize: 10.5,
    color: colors.textSecondary,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  operationFactors: { fontFamily: fontFamilies.medium, fontSize: 11.5, lineHeight: 16, color: '#166534' },
  operationRisks: { fontFamily: fontFamilies.medium, fontSize: 11.5, lineHeight: 16, color: '#B45309' },
  alternativeWindows: { fontFamily: fontFamilies.regular, fontSize: 10.5, lineHeight: 15, color: colors.muted },
  operationSummary: { fontFamily: fontFamilies.regular, fontSize: 12.5, lineHeight: 18, color: colors.textSecondary },
  operationsDisclaimer: { fontFamily: fontFamilies.regular, fontSize: 10.5, lineHeight: 15, color: colors.muted, paddingHorizontal: 14, paddingVertical: 10 },

  // Weather card
  weatherCard: { padding: 0, gap: 0, overflow: 'hidden' },
  weatherGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  etRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  etLabel: { fontFamily: fontFamilies.regular, fontSize: 13, color: colors.textSecondary },
  etValue: { fontFamily: fontFamilies.semiBold, fontSize: 13, color: colors.text },
  alertBox: {
    margin: 10,
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#F59E0B',
  },
  alertTitle: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: '#92400E' },
  alertDesc: { fontFamily: fontFamilies.regular, fontSize: 12, color: '#78350F', lineHeight: 17, marginTop: 2 },
  alertBoxCritical: { backgroundColor: '#FEE2E2', borderColor: '#DC2626' },

  // Climate risk by decades (задача 2.2)
  riskSummary: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 4,
  },
  riskScroll: { paddingHorizontal: 10, paddingVertical: 8, gap: 10 },
  riskCard: {
    width: 210,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 12,
    marginRight: 10,
  },
  riskCardPast: { opacity: 0.6 },
  riskCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  riskCardLabel: { fontFamily: fontFamilies.semiBold, fontSize: 13, color: colors.text, flex: 1 },
  riskPastTag: { fontFamily: fontFamilies.medium, fontSize: 10, color: colors.muted },
  riskCardPeriod: { fontFamily: fontFamilies.regular, fontSize: 11, color: colors.textSecondary, marginTop: 1 },
  riskBadge: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 8,
  },
  riskBadgeNum: { fontFamily: fontFamilies.bold, fontSize: 20 },
  riskBadgeLabel: { fontFamily: fontFamilies.semiBold, fontSize: 12 },
  riskFactors: {
    fontFamily: fontFamilies.regular,
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 15,
    marginTop: 8,
  },
  riskSource: {
    fontFamily: fontFamilies.regular,
    fontSize: 10,
    color: colors.muted,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },

  // Map
  segmentedWrap: {
    flexDirection: 'row',
    backgroundColor: '#E5E5EA',
    borderRadius: 10,
    padding: 2,
    gap: 2,
  },
  mapFrame: {
    height: 230,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: '#EAECE8',
  },
  map: { flex: 1 },
  mapFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mapFallbackText: { fontFamily: fontFamilies.regular, fontSize: 12, color: colors.muted },
  mapTag: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    backgroundColor: 'rgba(255,255,255,0.92)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    maxWidth: '80%',
  },
  mapTagText: { fontFamily: fontFamilies.medium, fontSize: 10.5, color: colors.text },
  mapTypeToggle: {
    position: 'absolute',
    right: 8,
    top: 8,
    backgroundColor: 'rgba(28,28,30,0.72)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  mapTypeToggleText: { fontFamily: fontFamilies.semiBold, fontSize: 11.5, color: '#FFFFFF' },
  ndviLegend: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  ndviLegendBar: { flex: 1, flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden' },
  ndviLegendSeg: { flex: 1 },
  ndviLegendVal: { fontFamily: fontFamilies.semiBold, fontSize: 10.5, color: colors.text },

  // Zone picker
  zonePicker: { flexDirection: 'row', gap: 8 },

  // Zone detail card
  zoneCard: { padding: 0, gap: 0 },
  zoneMetrics: { flexDirection: 'row', alignItems: 'center' },
  zoneMetricCell: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  zoneMetricVal: { fontFamily: fontFamilies.bold, fontSize: 18, color: colors.text },
  zoneMetricLabel: { fontFamily: fontFamilies.medium, fontSize: 11, color: colors.muted, marginTop: 3 },
  zoneInfoBlock: { paddingHorizontal: 14, paddingVertical: 10, gap: 4 },
  zoneInfoTitle: { fontFamily: fontFamilies.semiBold, fontSize: 11.5, letterSpacing: 0.3, color: colors.muted },
  zoneInfoText: { fontFamily: fontFamilies.regular, fontSize: 13.5, color: colors.text, lineHeight: 19 },
  zonePersistenceRow: { paddingHorizontal: 14, paddingVertical: 9 },
  zonePersistenceText: { fontFamily: fontFamilies.medium, fontSize: 12, color: colors.textSecondary },
  dispatchBtn: {
    margin: 12,
    marginTop: 4,
    backgroundColor: colors.primary,
    height: 46,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dispatchBtnText: { fontFamily: fontFamilies.semiBold, fontSize: 14, color: '#FFF' },

  // Savings card
  savingsCard: { padding: 14, gap: 0 },

  // Actions card
  actionsCard: { padding: 0, gap: 0 },

  // Inspections
  inspGroup: { padding: 0 },
  inspRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  inspOpen: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    paddingVertical: 10,
    gap: 12,
  },
  inspRowPressed: { backgroundColor: colors.surfaceSecondary },
  thumb: { width: 46, height: 46, borderRadius: 8, backgroundColor: colors.border },
  thumbPlaceholder: {
    width: 46,
    height: 46,
    borderRadius: 8,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbPlaceholderText: { fontFamily: fontFamilies.bold, fontSize: 10, color: colors.muted },
  inspMain: { flex: 1, gap: 3 },
  inspTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inspDate: { fontFamily: fontFamilies.semiBold, fontSize: 13.5, color: colors.text, flex: 1 },
  inspNote: { fontFamily: fontFamilies.regular, fontSize: 12, color: colors.textSecondary, lineHeight: 16 },
  chevron: { fontFamily: fontFamilies.regular, fontSize: 20, color: '#C7C7CC' },
  inspDeleteButton: {
    alignSelf: 'stretch',
    minWidth: 70,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  inspDeletePressed: { backgroundColor: colors.dangerSoft },
  inspDeleteText: { fontFamily: fontFamilies.semiBold, fontSize: 12, color: colors.danger },
  inspDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 72 },

  // Post-harvest notice card
  postHarvestCard: { padding: 12, backgroundColor: '#FEF3C7', borderWidth: StyleSheet.hairlineWidth, borderColor: '#F59E0B' },
  postHarvestText: { fontFamily: fontFamilies.regular, fontSize: 12.5, color: '#78350F', lineHeight: 18 },

  // Period selector
  periodSelectorLabel: { fontFamily: fontFamilies.semiBold, fontSize: 10.5, color: colors.textSecondary, letterSpacing: 0.5, marginHorizontal: 16, marginTop: 8, marginBottom: 2 },
  periodSelectorRow: { paddingHorizontal: 14, paddingVertical: 6, gap: 8 },
  periodChip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  periodChipActive: { backgroundColor: '#E7F3EB', borderColor: colors.primary },
  periodChipText: { fontFamily: fontFamilies.medium, fontSize: 12, color: colors.textSecondary },
  periodChipTextActive: { color: colors.primary, fontFamily: fontFamilies.semiBold },
  periodLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 4 },
  periodLoadingText: { fontFamily: fontFamilies.regular, fontSize: 12, color: colors.textSecondary },

  // Growth phase label
  growthPhaseLabel: { fontFamily: fontFamilies.medium, fontSize: 12, color: colors.primary, marginHorizontal: 16, marginBottom: 4 },
});
